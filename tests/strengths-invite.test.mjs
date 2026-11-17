// The nudge: Heshy presses a button in Manage, the client gets an email with a link that drops
// them straight into the assessment. The link carries a token naming only their own record.
import { kv } from '@vercel/kv';
import { readFileSync } from 'node:fs';
import handler from '../api/admin-data.js';
import portalHandler from '../api/portal-lookup.js';
import { strengthsInviteEmail } from '../api/_lib/email.js';
import { ITEMS, nextExtra } from '../api/_lib/assessment.js';

let pass = 0, fail = 0; const failures = [];
function check(name, cond, detail='') { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n    ' + detail : '')); } }

process.env.ADMIN_PASSWORD = 'pw';
process.env.SITE_URL = 'https://heshy-booking.vercel.app';

const store = new Map();
let appData, sentMail;
function reset() {
  appData = { clients: [
      { id: 'c1', name: 'Rivka Stern', email: 'rivka@example.com', phone: '3475550101' },
      { id: 'c2', name: 'No Email Person' }
    ], bookings: [], availability: { virtual: [], 'in-person': [] }, overrides: [], blockedDates: [], settings: {} };
  store.clear();
  store.set('admin-session:tok', true);
  sentMail = [];
}
kv.set = async (k, v) => { if (k === 'app-data') appData = v; else store.set(k, v); return 'OK'; };
kv.get = async k => (k === 'app-data' ? appData : (store.get(k) ?? null));
kv.del = async k => { store.delete(k); return 1; };
kv.lpush = async () => 1; kv.ltrim = async () => 'OK'; kv.lrange = async () => [];

// Stub the network rather than the module, so the real sendEmail is what runs.
let mailWorks = true;
process.env.RESEND_API_KEY = 'test-key';
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('resend.com')) {
    const body = JSON.parse(opts?.body || '{}');
    sentMail.push({ to: body.to?.[0], subject: body.subject, html: body.html, from: body.from });
    return { ok: mailWorks, status: mailWorks ? 200 : 500, text: async () => 'stub', json: async () => ({}) };
  }
  return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
};

function mockRes() {
  const r = {};
  r.status = c => { r.statusCode = c; return r; };
  r.json = b => { r.body = b; return r; };
  r.send = b => { r.body = b; return r; };
  return r;
}
const asAdmin = async body => { const res = mockRes(); await handler({ method: 'POST', query: {}, headers: { 'x-admin-token': 'tok' }, body }, res); return res; };

// --- sending it ---------------------------------------------------------------------------------
reset();
let res = await asAdmin({ action: 'send-strengths-invite', clientId: 'c1' });
check('the invite sends', res.statusCode === 200, `${res.statusCode} ${JSON.stringify(res.body)}`);
check('one email went out', sentMail.length === 1);
check('...to the client', sentMail[0]?.to === 'rivka@example.com', sentMail[0]?.to);
check('...with a subject about the assessment', /assessment/i.test(sentMail[0]?.subject || ''), sentMail[0]?.subject);
check('the send is recorded on the client', typeof appData.clients[0].strengthsInviteSentAt === 'number');
check('the response says where it went', res.body.to === 'rivka@example.com');

// The link has to carry a real, working token.
const link = (sentMail[0].html.match(/https:\/\/heshy-booking\.vercel\.app\/\?strengths=([A-Za-z0-9_-]+)/) || [])[1];
check('the email contains an assessment link with a token', !!link, sentMail[0].html.slice(0, 200));
check('the token is a real one, not a placeholder', !!link && link.length > 20);

// That token must actually let them save a result — the whole point of the nudge.
const items = {}; for (const q of ITEMS) items[q.id] = q.key === 'W' ? 5 : q.key === 'D' ? 4 : 1;
const extra = []; let nx; while ((nx = nextExtra({ items, extra }))) { extra.push(nx); items[nx] = 3; }
const pres = mockRes();
await portalHandler({ method: 'POST', query: {}, headers: {}, body: {
  action: 'save-strengths', strengthsToken: decodeURIComponent(link), answers: { items, extra } } }, pres);
check('the token in the email lets that client save their result', pres.statusCode === 200, `${pres.statusCode} ${JSON.stringify(pres.body)}`);
check('...onto their own record', !!appData.clients[0].strengths);
check('...and nobody else’s', !appData.clients[1].strengths);

// --- refusals -------------------------------------------------------------------------------------
reset();
res = await asAdmin({ action: 'send-strengths-invite', clientId: 'c2' });
check('a client with no email address is refused', res.statusCode === 400, String(res.statusCode));
check('...and nothing was sent', sentMail.length === 0);

res = await asAdmin({ action: 'send-strengths-invite', clientId: 'nobody' });
check('an unknown client is refused', res.statusCode === 404);

reset();
const noAuth = mockRes();
await handler({ method: 'POST', query: {}, headers: {}, body: { action: 'send-strengths-invite', clientId: 'c1' } }, noAuth);
check('it needs an admin session', noAuth.statusCode === 401, String(noAuth.statusCode));
check('...and sends nothing without one', sentMail.length === 0);

// The read-only agent key must not be able to email clients.
reset();
process.env.AGENT_READ_KEY = 'k'.repeat(48);
const agentRes = mockRes();
await handler({ method: 'POST', query: {}, headers: { 'x-agent-key': 'k'.repeat(48) }, body: { action: 'send-strengths-invite', clientId: 'c1' } }, agentRes);
check('the read-only key cannot email clients', sentMail.length === 0, JSON.stringify(sentMail));

// --- when the email fails ---------------------------------------------------------------------------
reset();
mailWorks = false;
res = await asAdmin({ action: 'send-strengths-invite', clientId: 'c1' });
check('a failed send is reported, not silently swallowed', res.statusCode === 502, String(res.statusCode));
check('...and is not recorded as sent', !appData.clients[0].strengthsInviteSentAt);
check('...and points at the problem log', /Problem log/i.test(res.body?.error || ''), res.body?.error);
mailWorks = true;

// --- the email itself ---------------------------------------------------------------------------------
const mail = strengthsInviteEmail({ name: 'Rivka Stern', email: 'r@example.com' }, 'TOKEN123');
check('the email greets them by first name', /Hi Rivka/.test(mail.html), mail.html.slice(0, 120));
check('it says it costs nothing', /no charge/i.test(mail.html));
check('it says roughly how long it takes', /8 minutes/i.test(mail.html));
check('it has a plain-text fallback link for broken buttons', (mail.html.match(/TOKEN123/g) || []).length >= 2);
check('a name with markup in it is escaped',
      !strengthsInviteEmail({ name: '<script>x</script>', email: 'a@b.com' }, 'T').html.includes('<script>x'));

// --- the page honours the link -----------------------------------------------------------------------
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
check('the page reads the token out of the link', /URLSearchParams\(window\.location\.search\)\.get\('strengths'\)/.test(html));
check('...opens the assessment with it', /openStrengths\('client', t\)/.test(html));
check('...and clears it from the address bar', /history\.replaceState/.test(html));
// It has to run at boot. An earlier version of this landed inside the Manage search box's
// keystroke handler, where it never fired on page load.
// The boot chain starts at column 0 — inside no function and no handler — and the strengths
// check is reached from it. The pay-link check now sits in front of it, which is still boot
// code; what this guards against is the whole thing drifting back inside something else.
const bootBlock = (html.match(/\nif\(!openPayLink\(\)\)\{[\s\S]{0,400}/) || [''])[0];
check('the link check runs when the app starts, not inside another handler',
      bootBlock.length > 0 && /openStrengthsFromLink\(\)/.test(bootBlock), bootBlock.slice(0, 200));
check('...and the normal page still loads when no link was followed',
      /openPasswordSetupFromLink\(\)\.then\(handled => \{ if\(!handled\) loadState\(\); \}\)/.test(html));
check('...and is a top-level function', /\nfunction openStrengthsFromLink\(\)\{/.test(html));
check('Manage has a button to send it', /data-send-strengths/.test(html));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILURES:\n' + failures.map(f => '  ' + f).join('\n')); process.exit(1); }
