// Saving a result. The browser sends answers, never a result — so these check that the server
// scores for itself, and that only someone entitled to write to a client record can.
import { kv } from '@vercel/kv';
import handler from '../api/portal-lookup.js';
import { issueScopedToken } from '../api/_lib/auth.js';
import { ITEMS, PAIRS, SCALE, score } from '../api/_lib/assessment.js';

let pass = 0, fail = 0; const failures = [];
function check(name, cond, detail='') { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n    ' + detail : '')); } }

globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

const store = new Map();
let appData;
function reset() {
  appData = {
    clients: [
      { id: 'c1', name: 'Rivka Stern', email: 'rivka@example.com', phone: '3475550101' },
      { id: 'c2', name: 'Yoily Klein', email: 'yoily@example.com', phone: '3475550202', wgLetters: 'GTDEIW' }
    ],
    bookings: [], availability: { virtual: [], 'in-person': [] }, overrides: [], blockedDates: [],
    settings: { hourlyRate: 500 }
  };
  store.clear();
}
kv.set = async (k, v) => { if (k === 'app-data') appData = v; else store.set(k, v); return 'OK'; };
kv.get = async k => (k === 'app-data' ? appData : (store.get(k) ?? null));
kv.del = async k => { store.delete(k); return 1; };

function answersFavouring(best, worst) {
  const items = {}; for (const q of ITEMS) items[q.id] = q.key === best ? 5 : q.key === worst ? 1 : 3;
  const pairs = {}; for (const p of PAIRS) pairs[p.id] = (p.a === best || p.b === worst) ? p.a : p.b;
  return { items, pairs, extra: [] };
}
function mockRes() {
  const r = {};
  r.status = c => { r.statusCode = c; return r; };
  r.json = b => { r.body = b; return r; };
  return r;
}
const post = async body => { const res = mockRes(); await handler({ method: 'POST', query: {}, headers: {}, body }, res); return res; };

// --- an invited client (just booked, not signed in) ---------------------------------------------
reset();
let invite = await issueScopedToken('strengths-invite', 'c1', 3600);
const good = answersFavouring('W', 'T');
let res = await post({ action: 'save-strengths', strengthsToken: invite, answers: good });
check('an invited client can save their result', res.statusCode === 200, `${res.statusCode} ${JSON.stringify(res.body)}`);
check('the result is stored on their record', !!appData.clients[0].strengths);
check('the server scored it itself', appData.clients[0].strengths.letters === score(good).letters,
      appData.clients[0].strengths?.letters);
check('it records when it was taken', typeof appData.clients[0].strengths.takenAt === 'number');
check('it records that it came from the assessment', appData.clients[0].strengths.source === 'assessment');
check('the letters field Manage reads is kept in step',
      appData.clients[0].wgLetters === appData.clients[0].strengths.letters);
check('the response tells the page the result', res.body.result?.letters === score(good).letters);
check('nobody else was touched', !appData.clients[1].strengths);

// --- a result sent by the browser is ignored; the answers decide -----------------------------------
reset();
invite = await issueScopedToken('strengths-invite', 'c1', 3600);
const loves = answersFavouring('E', 'I');
res = await post({ action: 'save-strengths', strengthsToken: invite, answers: loves,
                   result: { letters: 'TTTTTT' }, letters: 'WIDGET' });
check('a result supplied by the browser is ignored', appData.clients[0].strengths.letters === score(loves).letters,
      appData.clients[0].strengths?.letters);
check('...and it is not the one the browser claimed', appData.clients[0].strengths.letters !== 'TTTTTT');

// --- a signed-in portal client ----------------------------------------------------------------
reset();
store.set('portal-session:sess1', 'c2');
res = await post({ action: 'save-strengths', token: 'sess1', answers: answersFavouring('G', 'W') });
check('a signed-in client can save from the portal', res.statusCode === 200, String(res.statusCode));
check('retaking replaces the letters they already had',
      appData.clients[1].wgLetters === score(answersFavouring('G', 'W')).letters,
      appData.clients[1].wgLetters);

// --- who cannot save ----------------------------------------------------------------------------
reset();
res = await post({ action: 'save-strengths', answers: good });
check('no token at all is refused', res.statusCode === 401, String(res.statusCode));
check('...and nothing was written', !appData.clients[0].strengths);

res = await post({ action: 'save-strengths', strengthsToken: 'made-up', answers: good });
check('a made-up invite token is refused', res.statusCode === 401);
res = await post({ action: 'save-strengths', token: 'not-a-session', answers: good });
check('a made-up session token is refused', res.statusCode === 401);
check('still nothing written', !appData.clients[0].strengths);

// An invite names one client record and cannot be pointed at another.
reset();
invite = await issueScopedToken('strengths-invite', 'c1', 3600);
await post({ action: 'save-strengths', strengthsToken: invite, answers: good });
check('an invite writes only to the record it names',
      !!appData.clients[0].strengths && !appData.clients[1].strengths);

// --- incomplete or junk answers -------------------------------------------------------------------
reset();
invite = await issueScopedToken('strengths-invite', 'c1', 3600);
for (const [label, answers] of [
  ['nothing', null],
  ['an empty object', {}],
  ['a missing rating', { ...good, items: { ...good.items, q7: undefined } }],
  ['a rating out of range', { ...good, items: { ...good.items, q7: 11 } }],
  ['a missing forced choice', { ...good, pairs: { ...good.pairs, p3: undefined } }],
  ['a letter that was never offered', { ...good, pairs: { ...good.pairs, p3: 'Q' } }],
  ['too many follow-ups', { ...good, extra: Array.from({ length: 11 }, () => ({ a:'W', ai:0, b:'T', bi:0, pick:'W' })) }],
  ['a string instead of answers', 'WIDGET']
]) {
  const r = await post({ action: 'save-strengths', strengthsToken: invite, answers });
  check(`${label} is rejected`, r.statusCode === 400, `${r.statusCode} ${JSON.stringify(r.body)}`);
}
check('none of the junk was stored', !appData.clients[0].strengths);

// --- a complete run including follow-ups ------------------------------------------------------------
reset();
invite = await issueScopedToken('strengths-invite', 'c1', 3600);
const full = answersFavouring('D', 'G');
full.extra = [{ a: 'W', ai: 0, b: 'I', bi: 1, pick: 'W' }, { a: 'E', ai: 2, b: 'T', bi: 3, pick: 'T' }];
res = await post({ action: 'save-strengths', strengthsToken: invite, answers: full });
check('a run with follow-ups saves', res.statusCode === 200, String(res.statusCode));
check('...and the follow-ups affected the score', appData.clients[0].strengths.letters === score(full).letters);
check('...and it records whether the result settled', typeof appData.clients[0].strengths.clear === 'boolean');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILURES:\n' + failures.map(f => '  ' + f).join('\n')); process.exit(1); }
