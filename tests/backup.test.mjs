// Snapshots, and getting data back. Validating saves is only half the job if a mistake that
// does get through is permanent.
import { kv } from '@vercel/kv';
import { takeBackup, listBackups, readBackup, isDueForBackup } from '../api/_lib/backup.js';

let pass = 0, fail = 0; const failures = [];
function check(name, cond, detail='') { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n    ' + detail : '')); } }

let store = new Map();
kv.get = async k => { const v = store.get(k); return v === undefined ? null : JSON.parse(JSON.stringify(v)); };
kv.set = async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); return 'OK'; };
kv.del = async k => { store.delete(k); return 1; };
const reset = () => { store = new Map(); };

const record = (clients = 3, bookings = 5) => ({
  version: 7,
  clients: Array.from({ length: clients }, (_, i) => ({ id: 'c' + i, name: 'Client ' + i })),
  bookings: Array.from({ length: bookings }, (_, i) => ({ id: 'b' + i })),
  settings: { hourlyRate: 500, coupons: [{ code: 'A' }] }
});

// --- taking one ---------------------------------------------------------------------------------
reset();
let entry = await takeBackup(record(), 'daily');
check('a backup is taken', !!entry && !!entry.id, JSON.stringify(entry));
check('it records why', entry.reason === 'daily');
check('it records what was in it', entry.counts.clients === 3 && entry.counts.bookings === 5 && entry.counts.coupons === 1);
check('it records the version', entry.version === 7);

let list = await listBackups();
check('it appears in the list', list.length === 1 && list[0].id === entry.id);
check('the list holds counts, not the data itself', !('clients' in list[0]) || !Array.isArray(list[0].clients));

const back = await readBackup(entry.id);
check('the snapshot can be read back whole', back.clients.length === 3 && back.bookings.length === 5);
check('...with the settings intact', back.settings.hourlyRate === 500);

// --- newest first, and capped ----------------------------------------------------------------------
reset();
for (let i = 0; i < 25; i++) await takeBackup(record(i + 1, i), 'daily');
list = await listBackups();
check('only the newest 20 are kept', list.length === 20, String(list.length));
check('newest first', list[0].counts.clients === 25 && list[19].counts.clients === 6,
      `${list[0].counts.clients} … ${list[19].counts.clients}`);
check('the dropped payloads are deleted too, not left behind',
      [...store.keys()].filter(k => k.startsWith('backup:')).length === 20,
      String([...store.keys()].filter(k => k.startsWith('backup:')).length));

// --- only ids that really exist ------------------------------------------------------------------
reset();
entry = await takeBackup(record(), 'manual');
check('an unknown id returns nothing', (await readBackup('not-a-backup')) === null);
check('an empty id returns nothing', (await readBackup('')) === null);
check('a non-string id returns nothing', (await readBackup(null)) === null);
// A caller must not be able to read arbitrary KV keys through this.
store.set('backup:admin-session:secret', { secret: true });
check('a key that is not in the index cannot be read',
      (await readBackup('admin-session:secret')) === null);

// --- never breaks the thing it is protecting ---------------------------------------------------------
reset();
check('backing up nothing is a no-op, not an error', (await takeBackup(null, 'daily')) === null);
check('backing up a string is a no-op', (await takeBackup('oops', 'daily')) === null);

const realSet = kv.set;
kv.set = async () => { throw new Error('KV is down'); };
let threw = false;
try { await takeBackup(record(), 'daily'); } catch (e) { threw = true; }
check('a storage failure during backup never throws at the caller', !threw);
kv.set = realSet;

kv.get = async () => { throw new Error('KV is down'); };
check('a storage failure while listing returns an empty list', (await listBackups()).length === 0);
kv.get = async k => { const v = store.get(k); return v === undefined ? null : JSON.parse(JSON.stringify(v)); };

// --- when a daily backup is due ---------------------------------------------------------------------
reset();
check('with no backups at all, one is due', (await isDueForBackup(20)) === true);
await takeBackup(record(), 'daily');
check('just after one, another is not due', (await isDueForBackup(20)) === false);
const idx = store.get('backup-index');
idx[0].at = Date.now() - 25 * 60 * 60 * 1000;
store.set('backup-index', idx);
check('a day later, one is due again', (await isDueForBackup(20)) === true);

// --- the snapshot is a copy, not a live reference -------------------------------------------------------
reset();
const live = record(2, 2);
await takeBackup(live, 'manual');
live.clients.length = 0;
live.settings.hourlyRate = 1;
const saved = await readBackup((await listBackups())[0].id);
check('later changes to the record do not alter the snapshot',
      saved.clients.length === 2 && saved.settings.hourlyRate === 500,
      `${saved.clients.length} clients, rate ${saved.settings.hourlyRate}`);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILURES:\n' + failures.map(f => '  ' + f).join('\n')); process.exit(1); }
