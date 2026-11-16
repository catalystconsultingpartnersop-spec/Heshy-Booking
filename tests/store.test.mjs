// The lock that stops two writes erasing each other. These simulate the exact situation that
// used to lose data: a client booking at the same moment Heshy saves in Manage.
import { kv } from '@vercel/kv';
import { mutate, readData, SKIP_WRITE, StaleDataError } from '../api/_lib/store.js';

let pass = 0, fail = 0; const failures = [];
function check(name, cond, detail='') { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n    ' + detail : '')); } }

// A KV stub that behaves like Redis for the operations the lock relies on, and that can be made
// slow on purpose so overlapping writers genuinely overlap.
let store = new Map();
let readDelay = 0, writeDelay = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));

kv.get = async k => { if (readDelay) await sleep(readDelay); const v = store.get(k); return v === undefined ? null : JSON.parse(JSON.stringify(v)); };
kv.set = async (k, v, opts) => {
  // Redis SET NX is atomic: the check and the write are one indivisible step. Modelling it with
  // an await in between would make the stub racy in a way the real store never is.
  if (opts?.nx) {
    if (store.has(k)) return null;
    store.set(k, JSON.parse(JSON.stringify(v)));
    return 'OK';
  }
  if (writeDelay) await sleep(writeDelay);
  store.set(k, JSON.parse(JSON.stringify(v)));
  return 'OK';
};
kv.del = async k => { store.delete(k); return 1; };

function reset(data = { bookings: [], clients: [], version: 0 }) {
  store = new Map();
  store.set('app-data', data);
  readDelay = 0; writeDelay = 0;
}

// --- the original bug -----------------------------------------------------------------------
// Without a lock: both read [], both append one item, both write — one booking disappears.
reset();
readDelay = 20; writeDelay = 20;
await Promise.all([
  (async () => { const d = await kv.get('app-data'); await sleep(30); d.bookings.push({ id: 'client-booking' }); await kv.set('app-data', d); })(),
  (async () => { const d = await kv.get('app-data'); await sleep(30); d.bookings.push({ id: 'heshy-edit' }); await kv.set('app-data', d); })()
]);
check('without the lock, one of two concurrent writes is lost',
      store.get('app-data').bookings.length === 1,
      `kept ${store.get('app-data').bookings.length} — the stub no longer reproduces the bug`);

// With mutate(): both survive.
reset();
readDelay = 20; writeDelay = 20;
await Promise.all([
  mutate(d => { d.bookings.push({ id: 'client-booking' }); }),
  mutate(d => { d.bookings.push({ id: 'heshy-edit' }); })
]);
let after = store.get('app-data');
check('with the lock, both writes survive', after.bookings.length === 2,
      JSON.stringify(after.bookings));
check('...and both are the real items',
      after.bookings.some(b => b.id === 'client-booking') && after.bookings.some(b => b.id === 'heshy-edit'));

// --- many at once ------------------------------------------------------------------------------
reset();
readDelay = 2; writeDelay = 2;
await Promise.all(Array.from({ length: 12 }, (_, i) => mutate(d => { d.bookings.push({ id: 'b' + i }); })));
after = store.get('app-data');
check('twelve simultaneous writes all land', after.bookings.length === 12, String(after.bookings.length));
check('none of them duplicated', new Set(after.bookings.map(b => b.id)).size === 12);
check('the version counted every one', after.version === 12, String(after.version));

// --- the lock is always released ---------------------------------------------------------------
reset();
let threw = false;
try { await mutate(() => { throw new Error('something went wrong mid-write'); }); } catch (e) { threw = true; }
check('an error inside a write is passed to the caller', threw);
check('...and the lock is released, not left held', !store.has('app-data-lock'));
await mutate(d => { d.bookings.push({ id: 'after-failure' }); });
check('...so the next write still works', store.get('app-data').bookings.length === 1);

// A failed write must not bump the version or save half a change.
reset();
try { await mutate(d => { d.bookings.push({ id: 'doomed' }); throw new Error('fail'); }); } catch (e) {}
check('a failed write saves nothing', store.get('app-data').bookings.length === 0);
check('...and leaves the version alone', store.get('app-data').version === 0);

// --- reads that change nothing -----------------------------------------------------------------
reset();
const result = await mutate(() => SKIP_WRITE);
check('a write can bow out without saving', result === SKIP_WRITE);
check('...and the version does not move', store.get('app-data').version === 0);
check('...and the lock is still released', !store.has('app-data-lock'));

// --- a stale Manage tab --------------------------------------------------------------------------
reset();
await mutate(d => { d.bookings.push({ id: 'someone-elses-booking' }); });   // version 1
let stale = null;
try { await mutate(d => { d.bookings = []; }, { expectVersion: 0 }); }      // Manage loaded at 0
catch (e) { stale = e; }
check('a save from a stale page is refused', stale instanceof StaleDataError);
check('...and does not wipe the newer data', store.get('app-data').bookings.length === 1);
check('...and hands back the current record so the page can refresh', !!stale?.current?.bookings);
check('...with a message a person can act on', /out of date/i.test(stale?.message || ''), stale?.message);

// The same save with the right version goes through.
await mutate(d => { d.bookings.push({ id: 'ok' }); }, { expectVersion: 1 });
check('a save with the current version is accepted', store.get('app-data').bookings.length === 2);

// --- waiting, not failing ---------------------------------------------------------------------------
reset();
writeDelay = 60;
const started = Date.now();
await Promise.all([mutate(d => { d.clients.push({ id: 'a' }); }), mutate(d => { d.clients.push({ id: 'b' }); })]);
check('a waiting write succeeds rather than erroring', store.get('app-data').clients.length === 2);
check('...and it actually waited rather than racing', Date.now() - started >= 60);

// --- an empty store -----------------------------------------------------------------------------------
store = new Map();
let noData = null;
try { await mutate(d => { d.x = 1; }); } catch (e) { noData = e; }
check('a missing record is an error, not a silent new one', noData?.code === 'NO_DATA');
check('...and the lock is released even then', !store.has('app-data-lock'));

store = new Map();
await mutate(d => { d.bookings.push({ id: 'first' }); }, { fallback: { bookings: [], clients: [] } });
check('a caller may supply a starting record', store.get('app-data').bookings.length === 1);

// --- readData -------------------------------------------------------------------------------------------
reset({ bookings: [{ id: 'x' }], clients: [], version: 3 });
const d = await readData();
check('readData returns the record', d.bookings.length === 1 && d.version === 3);
store = new Map();
check('readData returns null when there is nothing', (await readData()) === null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILURES:\n' + failures.map(f => '  ' + f).join('\n')); process.exit(1); }
