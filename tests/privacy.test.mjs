// Guards what the unauthenticated endpoints are allowed to reveal.
// These are security properties, so they get a test rather than a comment.
import publicState from '../api/public-state.js';

let pass = 0, fail = 0; const failures = [];
function check(name, cond, detail='') {
  if (cond) pass++; else { fail++; failures.push(`${name}${detail ? '\n    ' + detail : ''}`); }
}

// A realistic record containing every private field the app stores.
const APP_DATA = {
  bookings: [{
    id: 'bk1', date: '2099-01-05', time: '11:00', durationMin: 60, type: 'in-person',
    clientId: 'c1', clientName: 'Rivka Stern', clientEmail: 'rivka@example.com',
    clientPhone: '3475550101', stripeCustomerId: 'cus_SECRET', summary: 'private notes',
    clientSummary: 'recap', amount: 500, cancelled: false, status: 'scheduled'
  }],
  clients: [{ id: 'c1', name: 'Rivka Stern', email: 'rivka@example.com', phone: '3475550101',
              notes: 'private', wgPdfData: 'https://blob.example/secret.pdf', blocked: true }],
  overrides: [{ id: 'o1', date: '2099-01-06', start: '10:00', end: '12:00', type: 'in-person',
                generalArea: 'Boro Park', address: '1234 Private St, Apt 5B. Buzzer 12.' }],
  blockedDates: [],
  availability: {
    virtual: [{ id: 'r1', days: [1,2,3,4], start: '11:00', end: '13:00' }],
    'in-person': [{ id: 'r4', days: [1,2,3,4], start: '11:00', end: '13:00',
                    generalArea: 'Staten Island', address: '40 Dewhurst St, Staten Island NY 10314.' }]
  },
  settings: {
    meetLink: 'https://meet.google.com/reusable-secret',
    location: '99 Secret Ave, Floor 3, code 4455',
    intakeQuestions: ['What do you do for work?'],
    durationOptions: [60], minLeadHours: 12, hourlyRate: 500,
    coupons: [{ code: 'FRIEND', discountType: 'free', usedByEmails: ['rivka@example.com'] }],
    adminNotes: 'should never be public'
  }
};

// Stand in for Vercel's kv without needing the package.
const kvModule = await import('@vercel/kv');
kvModule.kv.get = async () => APP_DATA;

function mockRes() {
  const r = { statusCode: null, body: null };
  r.status = c => { r.statusCode = c; return r; };
  r.json = b => { r.body = b; return r; };
  return r;
}

const res = mockRes();
await publicState({ method: 'GET', query: {}, headers: {} }, res);
const payload = JSON.stringify(res.body);

check('endpoint responded 200', res.statusCode === 200, `got ${res.statusCode}`);

// --- things that must NEVER appear in the public payload ---
const mustNotAppear = {
  'street address (weekly rule)': '40 Dewhurst St',
  'street address (one-off date)': '1234 Private St',
  'entry instructions': 'Buzzer 12',
  'default location setting': '99 Secret Ave',
  'reusable Meet link': 'reusable-secret',
  'client name': 'Rivka Stern',
  'client email': 'rivka@example.com',
  'client phone': '3475550101',
  'Stripe customer id': 'cus_SECRET',
  'session notes': 'private notes',
  'client recap': 'recap',
  'uploaded PDF link': 'secret.pdf',
  'coupon codes': 'FRIEND',
  'admin notes': 'should never be public'
};
for (const [label, needle] of Object.entries(mustNotAppear)) {
  check(`public payload hides ${label}`, !payload.includes(needle),
        `found "${needle}" in the response`);
}

// --- things the booking page genuinely needs, which must still be there ---
check('still sends general area (weekly)', payload.includes('Staten Island'));
check('still sends general area (one-off)', payload.includes('Boro Park'));
check('still sends intake questions', payload.includes('What do you do for work?'));
check('still sends booked times so slots are blocked', res.body.bookings.length === 1);
check('booked times carry no identity',
  Object.keys(res.body.bookings[0]).sort().join(',') === 'date,durationMin,time,type',
  'got: ' + Object.keys(res.body.bookings[0]).sort().join(','));
check('still sends availability windows',
  res.body.availability['in-person'][0].start === '11:00');
check('still sends hourly rate', res.body.settings.hourlyRate === 500);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILURES:\n' + failures.map(f => '  ' + f).join('\n')); process.exit(1); }
