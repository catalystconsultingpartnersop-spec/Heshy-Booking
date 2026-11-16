// The problem log is only useful if it records enough to diagnose a failure and never
// records anything that shouldn't be stored.
import { logError, readErrors, clearErrors } from '../api/_lib/errorlog.js';

let pass = 0, fail = 0; const failures = [];
function check(name, cond, detail='') { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n    ' + detail : '')); } }

// In-memory stand-in for the KV list.
const kvModule = await import('@vercel/kv');
let list = [];
kvModule.kv.lpush = async (k, v) => { list.unshift(v); return list.length; };
kvModule.kv.ltrim = async (k, a, b) => { list = list.slice(a, b + 1); return 'OK'; };
kvModule.kv.lrange = async (k, a, b) => list.slice(a, b + 1);
kvModule.kv.del = async () => { list = []; return 1; };

// --- a realistic Stripe failure ---
const stripeErr = Object.assign(new Error('Your card was declined.'), {
  name: 'StripeCardError', code: 'card_declined'
});
await logError('charge-booking', stripeErr, { bookingId: 'bk123', amount: 500 });

let entries = await readErrors();
check('records the failure', entries.length === 1);
check('records which endpoint', entries[0].where === 'charge-booking');
check('records the message', entries[0].message === 'Your card was declined.');
check('records the error type', entries[0].type === 'StripeCardError');
check('records the provider code', entries[0].code === 'card_declined');
check('records context', entries[0].context.bookingId === 'bk123');
check('records a timestamp', !isNaN(new Date(entries[0].at)));

// --- sensitive values must never land in the log ---
await clearErrors();
await logError('create-setup-intent', new Error('boom'), {
  email: 'client@example.com',
  card: '4242424242424242',
  cvc: '123',
  password: 'hunter2',
  token: 'tok_live_SECRET',
  clientSecret: 'seti_SECRET_secret',
  authorization: 'Bearer abc123'
});
entries = await readErrors();
const dump = JSON.stringify(entries);
check('card number not stored', !dump.includes('4242424242424242'), dump.slice(0,200));
check('cvc not stored', !dump.includes('123') || !('cvc' in entries[0].context));
check('password not stored', !dump.includes('hunter2'));
check('token not stored', !dump.includes('tok_live_SECRET'));
check('client secret not stored', !dump.includes('seti_SECRET_secret'));
check('authorization not stored', !dump.includes('Bearer abc123'));
check('email IS kept (needed to identify who hit it)', entries[0].context.email === 'client@example.com');

// --- long values are truncated so one failure can't fill storage ---
await clearErrors();
await logError('create-booking', new Error('x'.repeat(5000)), { note: 'y'.repeat(5000) });
entries = await readErrors();
check('long message truncated', entries[0].message.length <= 400, String(entries[0].message.length));
check('long context truncated', entries[0].context.note.length <= 210, String(entries[0].context.note.length));

// --- the list is capped ---
await clearErrors();
for (let i = 0; i < 250; i++) await logError('create-booking', new Error('e' + i), {});
entries = await readErrors(300);
check('capped at 200 entries', entries.length === 200, 'got ' + entries.length);
check('newest first', entries[0].message === 'e249', entries[0].message);

// --- logging must never throw, even when storage is broken ---
await clearErrors();
kvModule.kv.lpush = async () => { throw new Error('KV is down'); };
let threw = false;
try { await logError('create-booking', new Error('original failure'), {}); } catch (e) { threw = true; }
check('a broken log does not throw', threw === false);

// --- reading must survive broken storage too ---
kvModule.kv.lrange = async () => { throw new Error('KV is down'); };
let readThrew = false, result = null;
try { result = await readErrors(); } catch (e) { readThrew = true; }
check('a broken read does not throw', readThrew === false);
check('a broken read returns an empty list', Array.isArray(result) && result.length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILURES:\n' + failures.map(f => '  ' + f).join('\n')); process.exit(1); }
