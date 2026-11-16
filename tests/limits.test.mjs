// Limits on the public endpoints, and on what anyone can push into storage.
import { kv } from '@vercel/kv';
import { hit, limited, callerIp, checkBookingFields, checkDataUrl, MAX_PDF_BYTES } from '../api/_lib/limits.js';

let pass = 0, fail = 0; const failures = [];
function check(name, cond, detail='') { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n    ' + detail : '')); } }

let store = new Map();
kv.incr = async k => { const v = (Number(store.get(k)) || 0) + 1; store.set(k, v); return v; };
kv.expire = async () => 1;
kv.get = async k => store.get(k) ?? null;
kv.set = async (k, v) => { store.set(k, v); return 'OK'; };
kv.del = async k => { store.delete(k); return 1; };
const reset = () => { store = new Map(); };

// --- counting ------------------------------------------------------------------------------
reset();
let allowedCount = 0;
for (let i = 0; i < 25; i++) { const r = await hit('book', '1.2.3.4', 20, 3600); if (r.allowed) allowedCount++; }
check('the first 20 go through', allowedCount === 20, String(allowedCount));
check('the 21st does not', !(await hit('book', '1.2.3.4', 20, 3600)).allowed);

// A different caller is unaffected by someone else hitting the limit.
check('a different caller is not punished for it', (await hit('book', '5.6.7.8', 20, 3600)).allowed);
// And a different action is counted separately.
check('a different action is counted separately', (await hit('setup-intent', '1.2.3.4', 15, 3600)).allowed);

// --- it must fail open ---------------------------------------------------------------------------
reset();
const realIncr = kv.incr;
kv.incr = async () => { throw new Error('KV is down'); };
const r = await hit('book', '1.2.3.4', 1, 60);
check('if the counter itself breaks, requests still go through', r.allowed === true);
kv.incr = realIncr;

// --- the handler guard ------------------------------------------------------------------------------
reset();
function mockRes() {
  const o = {};
  o.status = c => { o.statusCode = c; return o; };
  o.json = b => { o.body = b; return o; };
  return o;
}
const req = { headers: { 'x-forwarded-for': '9.9.9.9' }, socket: {} };
let stopped = false;
for (let i = 0; i < 3; i++) stopped = await limited(req, mockRes(), 'book', 2, 3600);
check('the guard stops the third request', stopped === true);
const res = mockRes();
await limited(req, res, 'book', 2, 3600);
check('...with 429, not an error', res.statusCode === 429);
check('...and a message a person can understand', /wait a few minutes/i.test(res.body?.error || ''), res.body?.error);

// --- identifying the caller ---------------------------------------------------------------------------
check('reads the forwarded address', callerIp({ headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }, socket: {} }) === '1.1.1.1');
check('falls back to the real-ip header', callerIp({ headers: { 'x-real-ip': '3.3.3.3' }, socket: {} }) === '3.3.3.3');
check('falls back to the socket', callerIp({ headers: {}, socket: { remoteAddress: '4.4.4.4' } }) === '4.4.4.4');
check('never throws when there is nothing to go on', callerIp({ headers: {} }) === 'unknown');

// --- field sizes ------------------------------------------------------------------------------------------
check('a normal booking passes', checkBookingFields({ name: 'Rivka Stern', email: 'r@example.com', phone: '3475550101' }) === null);
check('a 10,000-character name is refused', /name is too long/i.test(checkBookingFields({ name: 'x'.repeat(10000) }) || ''));
check('a huge email is refused', /email/i.test(checkBookingFields({ email: 'x'.repeat(1000) }) || ''));
check('a huge phone number is refused', /phone/i.test(checkBookingFields({ phone: '1'.repeat(500) }) || ''));
check('a huge coupon code is refused', /coupon/i.test(checkBookingFields({ couponCode: 'X'.repeat(500) }) || ''));
check('500 intake answers are refused', /too many answers/i.test(checkBookingFields({ intakeAnswers: Array(500).fill('a') }) || ''));
check('one enormous answer is refused', /too long/i.test(checkBookingFields({ intakeAnswers: ['x'.repeat(50000)] }) || ''));
check('answers that are not a list are refused', !!checkBookingFields({ intakeAnswers: 'not a list' }));
check('no answers at all is fine', checkBookingFields({ name: 'A', email: 'b@c.com' }) === null);

// --- uploads ------------------------------------------------------------------------------------------------
const pdf = 'data:application/pdf;base64,JVBERi0xLjQKJeLjz9MK';           // really starts %PDF-
const notPdf = 'data:application/pdf;base64,SGVsbG8gd29ybGQsIG5vdCBhIFBERg=='; // claims to be, isn't
check('a real PDF is accepted', checkDataUrl(pdf, { expect: 'pdf', maxBytes: MAX_PDF_BYTES }) === null);
check('a file that only claims to be a PDF is refused',
      /doesn.t look like a PDF/i.test(checkDataUrl(notPdf, { expect: 'pdf', maxBytes: MAX_PDF_BYTES }) || ''));
check('something that is not a data URL is refused', !!checkDataUrl('https://example.com/x.pdf', { expect: 'pdf', maxBytes: MAX_PDF_BYTES }));
check('a data URL that is not base64 is refused', !!checkDataUrl('data:application/pdf,%PDF-1.4', { expect: 'pdf', maxBytes: MAX_PDF_BYTES }));
check('nonsense is refused', !!checkDataUrl('', { expect: 'pdf', maxBytes: MAX_PDF_BYTES }) && !!checkDataUrl(null, { expect: 'pdf', maxBytes: MAX_PDF_BYTES }));

// Size is worked out from the encoded length, without decoding it into memory first.
const huge = 'data:application/pdf;base64,JVBERi' + 'A'.repeat(30 * 1024 * 1024);
const sizeErr = checkDataUrl(huge, { expect: 'pdf', maxBytes: MAX_PDF_BYTES });
check('an oversized file is refused', /too large/i.test(sizeErr || ''), sizeErr);
check('...and the message says what the limit is', /15MB/.test(sizeErr || ''), sizeErr);
check('a file just under the limit is accepted',
      checkDataUrl('data:application/pdf;base64,JVBERi' + 'A'.repeat(1024), { expect: 'pdf', maxBytes: MAX_PDF_BYTES }) === null);

// Without expect:'pdf', the content isn't second-guessed — only the size.
check('a non-PDF upload is judged on size alone',
      checkDataUrl(notPdf, { maxBytes: MAX_PDF_BYTES }) === null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILURES:\n' + failures.map(f => '  ' + f).join('\n')); process.exit(1); }
