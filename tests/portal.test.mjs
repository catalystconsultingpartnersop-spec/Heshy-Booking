// Covers what a client sees in their portal: a session is "Upcoming" only while it is
// genuinely still ahead, and anything already behind them shows under history.
import portalLookup from '../api/portal-lookup.js';
import { etToUtc } from '../api/_lib/time.js';

let pass = 0, fail = 0; const failures = [];
function check(name, cond, detail='') { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n    ' + detail : '')); } }

// Build dates relative to now so the suite doesn't rot.
const etDate = ms => new Intl.DateTimeFormat('en-CA', { timeZone:'America/New_York', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date(ms));
const DAY = 86400000;
const LONG_AGO = etDate(Date.now() - 30*DAY);
const YESTERDAY = etDate(Date.now() - DAY);
const NEXT_WEEK = etDate(Date.now() + 7*DAY);

const CLIENT = { id:'c1', name:'Rivka Stern', email:'rivka@example.com', phone:'3475550101', stripeCustomerId:'cus_1' };
const APP_DATA = {
  clients: [CLIENT],
  settings: { clientCancelCutoffHours: 3 },
  bookings: [
    // The exact case that was wrong: an old session that was never charged.
    { id:'old-unbilled', clientId:'c1', date: LONG_AGO, time:'11:00', durationMin:60, type:'virtual', status:'scheduled' },
    // Marked complete rather than charged — also used to sit under Upcoming forever.
    { id:'old-complete', clientId:'c1', date: YESTERDAY, time:'11:00', durationMin:60, type:'virtual', status:'completed' },
    // Properly charged.
    { id:'old-charged', clientId:'c1', date: LONG_AGO, time:'12:00', durationMin:60, type:'virtual', status:'charged', amount:500 },
    // Charged and then cancelled — must stay visible, they were billed.
    { id:'charged-cancelled', clientId:'c1', date: LONG_AGO, time:'09:00', durationMin:60, type:'virtual', status:'charged', amount:250, cancelled:true },
    // Cancelled and never charged — should appear nowhere.
    { id:'cancelled', clientId:'c1', date: NEXT_WEEK, time:'11:00', durationMin:60, type:'virtual', status:'scheduled', cancelled:true },
    // A genuine future session.
    { id:'future', clientId:'c1', date: NEXT_WEEK, time:'11:00', durationMin:60, type:'in-person', status:'scheduled' },
    // Someone else's booking must never leak in.
    { id:'other', clientId:'c2', date: NEXT_WEEK, time:'15:00', durationMin:60, type:'virtual', status:'scheduled' }
  ]
};

const kvModule = await import('@vercel/kv');
const store = new Map([['portal-session:tok', 'c1']]);
kvModule.kv.get = async k => (k === 'app-data' ? APP_DATA : store.get(k) ?? null);
kvModule.kv.set = async () => null;
kvModule.kv.del = async () => null;

function mockRes() {
  const r = {};
  r.status = c => { r.statusCode = c; return r; };
  r.json = b => { r.body = b; return r; };
  return r;
}

const res = mockRes();
await portalLookup({ method:'GET', query:{ action:'session', token:'tok' }, headers:{}, body:null }, res);
const body = res.body;

check('portal returned the client', body && body.found === true, JSON.stringify(body).slice(0,200));

const upIds = body.upcoming.map(b => b.id);
check('old unbilled session is NOT upcoming', !upIds.includes('old-unbilled'), 'upcoming: ' + upIds.join(','));
check('session marked complete is NOT upcoming', !upIds.includes('old-complete'));
check('cancelled session is NOT upcoming', !upIds.includes('cancelled'));
check('genuine future session IS upcoming', upIds.includes('future'));
check('only the future session is upcoming', upIds.length === 1, 'got ' + upIds.length);

const pastDates = body.past.map(b => b.date + ' ' + (b.amount ?? 'n/a'));
check('charged session appears in history', body.past.some(b => b.amount === 500));
check('charged-then-cancelled still appears', body.past.some(b => b.amount === 250));
check('old unbilled session appears in history', body.past.some(b => b.awaitingBilling === true),
  'past: ' + JSON.stringify(pastDates));
check('unbilled past session is flagged, not shown as $0',
  body.past.filter(b => b.awaitingBilling).every(b => b.amount == null));
check('cancelled-and-never-charged appears nowhere',
  !upIds.includes('cancelled') && body.past.length === 4, 'past count ' + body.past.length);

// No other client's data, and no internal fields.
const payload = JSON.stringify(body);
check("another client's booking does not leak", !payload.includes('other'));
check('no internal session notes leak', !payload.includes('stripeCustomerId'));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILURES:\n' + failures.map(f => '  ' + f).join('\n')); process.exit(1); }
