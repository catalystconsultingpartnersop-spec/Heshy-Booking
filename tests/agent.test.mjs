// The agent key is a credential handed to a third party, so these are the tests that matter:
// it must never write, and routine reads must never carry client personal information.
import handler from '../api/admin-data.js';
import { buildSummary, buildDetail } from '../api/_lib/diagnostics.js';

let pass = 0, fail = 0; const failures = [];
function check(name, cond, detail='') { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n    ' + detail : '')); } }

const GOOD_KEY = 'k'.repeat(48);
process.env.AGENT_READ_KEY = GOOD_KEY;
process.env.ADMIN_PASSWORD = 'the-real-admin-password';

const APP_DATA = {
  clients: [
    { id:'c1', name:'Rivka Stern', email:'rivka@example.com', phone:'3475550101',
      stripeCustomerId:'cus_SECRET1', notes:'private note about Rivka',
      wgPdfData:'https://blob.example/secret.pdf', wgLetters:'WDGE', blocked:false },
    { id:'c2', name:'Yoily Klein', email:'yoily@example.com', phone:'3475550202', blocked:true }
  ],
  bookings: [
    { id:'bk1', clientId:'c1', date:'2099-01-05', time:'11:00', durationMin:60, type:'virtual',
      clientName:'Rivka Stern', clientEmail:'rivka@example.com', clientPhone:'3475550101',
      status:'scheduled', meetLink:'https://meet.google.com/aaa-bbbb-ccc',
      calendarEventId:'ev1', summary:'she is worried about her partner' },
    { id:'bk2', clientId:'c2', date:'2099-01-06', time:'11:00', durationMin:60, type:'virtual',
      clientName:'Yoily Klein', clientEmail:'yoily@example.com',
      status:'scheduled', meetLink:'https://meet.google.com/ddd-eeee-fff' },
    { id:'bk3', clientId:'c1', date:'2020-01-05', time:'11:00', durationMin:60, type:'in-person',
      clientName:'Rivka Stern', status:'charged', amount:500 }
  ],
  availability: { virtual:[{id:'r1',days:[1,2,3,4],start:'11:00',end:'13:00'}],
                  'in-person':[{id:'r4',days:[1],start:'11:00',end:'13:00',
                                generalArea:'Boro Park', address:'1234 Private St, buzzer 12'}] },
  overrides: [], blockedDates: [],
  settings: { hourlyRate:500, durationOptions:[60], minLeadHours:12, billingMode:'actual',
              location:'99 Secret Ave, code 4455', meetLink:'https://meet.google.com/fallback-xyz',
              intakeQuestions:['What do you do?'], coupons:[{code:'FRIEND'}] }
};

const kvModule = await import('@vercel/kv');
let writes = [];
kvModule.kv.get = async k => (k === 'app-data' ? JSON.parse(JSON.stringify(APP_DATA)) : null);
kvModule.kv.set = async (k, v) => { writes.push({ op:'set', k }); return 'OK'; };
kvModule.kv.del = async k => { writes.push({ op:'del', k }); return 1; };
kvModule.kv.lpush = async () => 1;
kvModule.kv.ltrim = async () => 'OK';
kvModule.kv.lrange = async () => [];

function mockRes() {
  const r = {};
  r.status = c => { r.statusCode = c; return r; };
  r.json = b => { r.body = b; return r; };
  r.send = b => { r.body = b; return r; };
  return r;
}
async function call({ method='GET', query={}, body=null, headers={} }) {
  const res = mockRes();
  await handler({ method, query, body, headers }, res);
  return res;
}

// ---------- the summary must carry no client identity ----------
writes = [];
let res = await call({ headers:{ 'x-agent-key': GOOD_KEY } });
check('summary returns 200', res.statusCode === 200, String(res.statusCode));
const dump = JSON.stringify(res.body);
for (const [label, needle] of Object.entries({
  'client name':'Rivka Stern', 'other client name':'Yoily Klein',
  'client email':'rivka@example.com', 'client phone':'3475550101',
  'stripe customer':'cus_SECRET1', 'private note':'private note about Rivka',
  'session notes':'worried about her partner', 'uploaded pdf link':'secret.pdf',
  'street address':'1234 Private St', 'entry instructions':'buzzer 12',
  'default location':'99 Secret Ave', 'coupon code':'FRIEND',
  'working meet link':'aaa-bbbb-ccc', 'fallback meet link':'fallback-xyz'
})) check(`summary hides ${label}`, !dump.includes(needle), `found "${needle}"`);

// ---------- but it must still be useful ----------
check('counts clients', res.body.counts.clients === 2);
check('counts upcoming', res.body.counts.upcoming === 2, String(res.body.counts.upcoming));
check('counts needs-billing', res.body.counts.needsBilling === 0);
check('counts blocked clients', res.body.counts.clientsBlocked === 1);
check('answers the Meet-link question: all distinct', res.body.meetLinks.allDistinct === true);
check('answers it with numbers', res.body.meetLinks.distinctLinks === 2 && res.body.meetLinks.virtualBookings === 2);
check('flags that a fallback link is configured', res.body.meetLinks.fallbackConfiguredInSettings === true);
check('shows general area', dump.includes('Boro Park'));
check('flags that an address exists without revealing it', res.body.availability.inPersonRules[0].hasAddress === true);
check('lists bookings without names', res.body.bookings.length === 3 && !('clientName' in res.body.bookings[0]));

// A shared Meet link across calls must be detectable.
const shared = JSON.parse(JSON.stringify(APP_DATA));
shared.bookings[1].meetLink = shared.bookings[0].meetLink;
const s2 = buildSummary(shared);
check('detects a shared Meet link', s2.meetLinks.allDistinct === false && s2.meetLinks.distinctLinks === 1);

// ---------- the key must never write ----------
const WRITE_ATTEMPTS = [
  { name:'full data replace (POST body)', method:'POST', body:{ bookings:[], clients:[] } },
  { name:'cancel a booking', method:'POST', body:{ action:'cancel-booking', bookingId:'bk1' } },
  { name:'reschedule a booking', method:'POST', body:{ action:'reschedule-booking', bookingId:'bk1', newDate:'2099-02-02', newTime:'11:00' } },
  { name:'clear the problem log', method:'POST', body:{ action:'clear-error-log' } },
  { name:'log in and mint a token', method:'POST', body:{ action:'login', password:'the-real-admin-password' } },
  { name:'log out', method:'POST', body:{ action:'logout' } },
  { name:'upload a PDF', method:'POST', body:{ action:'upload-pdf', fileName:'x.pdf', fileDataUrl:'data:application/pdf;base64,AAAA' } },
  { name:'migrate blobs', method:'POST', body:{ action:'migrate-blobs' } }
];
for (const attempt of WRITE_ATTEMPTS) {
  writes = [];
  const r = await call({ method: attempt.method, body: attempt.body, headers:{ 'x-agent-key': GOOD_KEY } });
  check(`refuses to ${attempt.name}`, writes.length === 0,
        `wrote: ${JSON.stringify(writes)} status ${r.statusCode}`);
  check(`  ...and returns no admin token for "${attempt.name}"`, !JSON.stringify(r.body||{}).includes('token'));
}

// ---------- a wrong key gets nothing ----------
for (const bad of ['', 'x', 'k'.repeat(47), 'k'.repeat(49), 'K'.repeat(48)]) {
  const r = await call({ headers:{ 'x-agent-key': bad } });
  check(`rejects key ${JSON.stringify(bad.slice(0,6))}… (len ${bad.length})`, r.statusCode === 401, String(r.statusCode));
}

// ---------- with no key configured on the server, the door is shut ----------
delete process.env.AGENT_READ_KEY;
res = await call({ headers:{ 'x-agent-key': GOOD_KEY } });
check('no server key means no access', res.statusCode === 401);
process.env.AGENT_READ_KEY = GOOD_KEY;

// ---------- detail view is opt-in and scoped to one record ----------
const d1 = buildDetail(APP_DATA, { bookingId:'bk1' });
check('detail returns the asked-for booking', d1.booking && d1.booking.id === 'bk1');
check('detail of a booking does not include every client', !('clients' in d1));
const d2 = buildDetail(APP_DATA, { clientId:'c1' });
check('detail returns one client plus their bookings', d2.client.id === 'c1' && d2.bookings.length === 2);
check('detail of one client excludes the other', !JSON.stringify(d2).includes('Yoily Klein'));
check('detail with nothing specified returns an error', !!buildDetail(APP_DATA, {}).error);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILURES:\n' + failures.map(f => '  ' + f).join('\n')); process.exit(1); }
