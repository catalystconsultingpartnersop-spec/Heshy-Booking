// A client moving their own session.
//
// Until this existed the only way to change a time was to cancel and book again, which released
// the slot before knowing another one was free — so a client who wanted Thursday instead of
// Wednesday could end up with neither. The rules here are deliberately the same ones a fresh
// booking already goes through; this adds no way to get a time that wasn't on offer anyway.
import { kv } from '@vercel/kv';
import { readFileSync } from 'node:fs';
import portalHandler from '../api/portal-lookup.js';
import adminHandler from '../api/admin-data.js';
import { rescheduledEmail, clientRescheduledAlertEmail } from '../api/_lib/email.js';
import { resolveAddress, addMinutes, syncCalendarMove } from '../api/_lib/schedulehelpers.js';

let pass = 0, fail = 0; const failures = [];
function check(name, cond, detail='') { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n    ' + detail : '')); } }

process.env.RESEND_API_KEY = 'test';
process.env.SITE_URL = 'https://heshy-booking.vercel.app';

let sent = [], store = new Map(), appData;
let calendarCalls = [];
let calendarPatchOk = true, calendarPatchStatus = 200, hasGoogle = true;

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('resend.com')) {
    const body = JSON.parse(opts?.body || '{}');
    sent.push({ to: body.to?.[0], subject: body.subject, html: body.html });
    return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
  }
  if (u.includes('oauth2.googleapis.com')) {
    return { ok: true, status: 200, json: async () => ({ access_token: hasGoogle ? 'at' : null }), text: async () => '' };
  }
  if (u.includes('googleapis.com/calendar')) {
    calendarCalls.push({ url: u, method: opts?.method, body: JSON.parse(opts?.body || '{}') });
    if (opts?.method === 'PATCH') {
      return { ok: calendarPatchOk, status: calendarPatchStatus, json: async () => ({ id: 'ev1' }), text: async () => 'err' };
    }
    return { ok: true, status: 200, json: async () => ({ id: 'ev-new', hangoutLink: 'https://meet.example/new' }), text: async () => '' };
  }
  return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
};
kv.get = async k => (k === 'app-data' ? appData : (store.get(k) ?? null));
kv.set = async (k, v) => { if (k === 'app-data') appData = v; else store.set(k, v); return 'OK'; };
kv.del = async k => { store.delete(k); return 1; };
kv.incr = async k => { const v = (Number(store.get(k)) || 0) + 1; store.set(k, v); return v; };
kv.expire = async () => 1;
kv.lpush = async () => 1; kv.ltrim = async () => 'OK'; kv.lrange = async () => [];

// Every weekday open 09:00-17:00, so the test is about the move, not about which day it is.
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

function reset() {
  sent = []; store = new Map(); calendarCalls = [];
  calendarPatchOk = true; calendarPatchStatus = 200; hasGoogle = true;
  store.set('portal-session:psess', 'c1');
  store.set('portal-session:other', 'c2');
  store.set('admin-session:tok', true);
  store.set('google-refresh-token', 'rt');
  appData = {
    clients: [
      { id: 'c1', name: 'Rivka Stern', email: 'rivka@example.com', phone: '3475550101' },
      { id: 'c2', name: 'Someone Else', email: 'else@example.com', phone: '3475550202' }
    ],
    bookings: [{
      id: 'b1', clientId: 'c1', clientName: 'Rivka Stern', clientEmail: 'rivka@example.com',
      date: '2099-03-04', time: '11:00', durationMin: 60, type: 'virtual', status: 'scheduled',
      calendarEventId: 'ev1', meetLink: 'https://meet.example/old', reminderSentAt: 123
    }],
    availability: {
      virtual: [{ id: 'r1', days: ALL_DAYS, start: '09:00', end: '17:00' }],
      'in-person': [{ id: 'r2', days: ALL_DAYS, start: '09:00', end: '17:00', address: '123 Main St, Boro Park' }]
    },
    overrides: [], blockedDates: [],
    settings: { hourlyRate: 500, clientCancelCutoffHours: 3, minLeadHours: 12, location: 'Default office' }
  };
}
function mockRes() {
  const r = {};
  r.status = c => { r.statusCode = c; return r; };
  r.json = b => { r.body = b; return r; };
  r.setHeader = () => r;
  return r;
}
async function doMove(body) {
  const res = mockRes();
  await portalHandler({ method: 'POST', query: {}, headers: {}, body: { action: 'reschedule-booking', ...body } }, res);
  return res;
}

// --- the happy path -----------------------------------------------------------------------------
reset();
let res = await doMove({ token: 'psess', bookingId: 'b1', newDate: '2099-03-06', newTime: '14:00' });
check('a client can move their own session', res.statusCode === 200, `${res.statusCode} ${JSON.stringify(res.body)}`);
check('the booking actually moves', appData.bookings[0].date === '2099-03-06' && appData.bookings[0].time === '14:00',
      `${appData.bookings[0].date} ${appData.bookings[0].time}`);
check('it records that the client did it', appData.bookings[0].rescheduledBy === 'client');
check('it records when', typeof appData.bookings[0].rescheduledAt === 'number');
check('the length is unchanged', appData.bookings[0].durationMin === 60);
check('the format is unchanged', appData.bookings[0].type === 'virtual');
check('it is not left looking cancelled', !appData.bookings[0].cancelled);
// The pending reminder describes the old time, so it has to be sent again.
check('the old reminder is cleared so a fresh one goes out', !('reminderSentAt' in appData.bookings[0]));
check('the new time comes back for the page to show', res.body?.date === '2099-03-06' && res.body?.time === '14:00');
check('nothing is warned about when it all worked', !res.body?.warning, res.body?.warning);

// --- the calendar follows -------------------------------------------------------------------------
check('the calendar event is patched, not duplicated', calendarCalls.filter(c => c.method === 'PATCH').length === 1,
      JSON.stringify(calendarCalls.map(c => c.method)));
check('...to the new start', calendarCalls[0]?.body?.start?.dateTime === '2099-03-06T14:00:00');
check('...and the right end', calendarCalls[0]?.body?.end?.dateTime === '2099-03-06T15:00:00');
check('...on the Eastern clock, not the server\'s', calendarCalls[0]?.body?.start?.timeZone === 'America/New_York');
check('...telling the attendee', /sendUpdates=all/.test(calendarCalls[0]?.url || ''));

// --- both sides are told ---------------------------------------------------------------------------
check('two emails go out', sent.length === 2, JSON.stringify(sent.map(s => s.to)));
const toClient = sent.find(s => s.to === 'rivka@example.com');
const toHeshy = sent.find(s => s.to === 'heshy@catalystconsultingnyc.com');
check('...one to the client', !!toClient);
check('...and one to Heshy', !!toHeshy);
check('the client\'s copy reads as their own request, not a move by Heshy',
      /as you asked/i.test(toClient?.html || '') && !/Heshy has moved/.test(toClient?.html || ''),
      (toClient?.html || '').slice(0, 300));
check('...and names the new time', /Mar 6/.test(toClient?.html || ''));
check('...and the old one, so they can see what changed', /Mar 4/.test(toClient?.html || ''));
check('Heshy\'s alert names the client', /Rivka Stern/.test((toHeshy?.subject || '') + (toHeshy?.html || '')));
check('...and both times', /Mar 6/.test(toHeshy?.html || '') && /Mar 4/.test(toHeshy?.html || ''));
check('...and links to their profile', /#manage\/client\/c1/.test(toHeshy?.html || ''));

// --- it has to be your own session ------------------------------------------------------------------
reset();
res = await doMove({ token: 'other', bookingId: 'b1', newDate: '2099-03-06', newTime: '14:00' });
check('another client cannot move someone else\'s session', res.statusCode === 403, String(res.statusCode));
check('...and nothing moved', appData.bookings[0].date === '2099-03-04');

reset();
res = await doMove({ token: 'nope', bookingId: 'b1', newDate: '2099-03-06', newTime: '14:00' });
check('an unknown session token is refused', res.statusCode === 401, String(res.statusCode));

reset();
res = await doMove({ token: 'psess', bookingId: 'b1' });
check('a missing time is asked for rather than guessed', res.statusCode === 400 && /pick a new date and time/i.test(res.body?.error || ''),
      JSON.stringify(res.body));

// --- the same rules a booking goes through ------------------------------------------------------------
reset();
res = await doMove({ token: 'psess', bookingId: 'b1', newDate: '2099-03-06', newTime: '20:00' });
check('a time outside open hours is refused', res.statusCode === 400 && /open hours/i.test(res.body?.error || ''), JSON.stringify(res.body));
check('...and the session stays where it was', appData.bookings[0].time === '11:00');

reset();
res = await doMove({ token: 'psess', bookingId: 'b1', newDate: '2020-03-06', newTime: '14:00' });
check('a time in the past is refused', res.statusCode === 400, JSON.stringify(res.body));

reset();
// Clients are held to the notice period on the new time too — admins aren't, clients are.
// Times have to be built on the Eastern wall clock, which is what the app stores; building them
// from UTC fields would land hours off and quietly test nothing.
const pad = n => String(n).padStart(2, '0');
function etWallClock(msFromNow) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date(Date.now() + msFromNow)).reduce((a, p) => (a[p.type] = p.value, a), {});
  return { date: `${f.year}-${f.month}-${f.day}`, time: `${pad(Number(f.hour) % 24)}:00` };
}
const soon = etWallClock(2 * 60 * 60 * 1000);   // two hours out, inside the 12-hour notice period
res = await doMove({ token: 'psess', bookingId: 'b1', newDate: soon.date, newTime: soon.time });
check('a client cannot move into the notice period', res.statusCode === 400 && /too soon/i.test(res.body?.error || ''),
      JSON.stringify(res.body));

reset();
appData.bookings.push({ id: 'b2', clientId: 'c2', date: '2099-03-06', time: '14:00', durationMin: 60, type: 'in-person', status: 'scheduled' });
res = await doMove({ token: 'psess', bookingId: 'b1', newDate: '2099-03-06', newTime: '14:00' });
check('a slot someone else holds is refused', res.statusCode === 400 && /already booked/i.test(res.body?.error || ''), JSON.stringify(res.body));
check('...even when the other session is a different format', appData.bookings[0].time === '11:00');

reset();
appData.blockedDates = [{ date: '2099-03-06', type: 'virtual' }];
res = await doMove({ token: 'psess', bookingId: 'b1', newDate: '2099-03-06', newTime: '14:00' });
check('a blocked date is refused', res.statusCode === 400, JSON.stringify(res.body));

// Moving onto its own slot: the session itself must not be treated as a clash.
reset();
res = await doMove({ token: 'psess', bookingId: 'b1', newDate: '2099-03-04', newTime: '11:30' });
check('a session does not block itself when overlapping its own slot', res.statusCode === 200, JSON.stringify(res.body));
check('...and it lands on the new time', appData.bookings[0].time === '11:30');

reset();
res = await doMove({ token: 'psess', bookingId: 'b1', newDate: '2099-03-04', newTime: '11:00' });
check('moving to the time it already has is refused plainly', res.statusCode === 400 && /already booked for/i.test(res.body?.error || ''),
      JSON.stringify(res.body));

// --- sessions that can no longer be moved ------------------------------------------------------------
reset();
appData.bookings[0].cancelled = true;
res = await doMove({ token: 'psess', bookingId: 'b1', newDate: '2099-03-06', newTime: '14:00' });
check('a cancelled session cannot be moved', res.statusCode === 400 && /cancelled/i.test(res.body?.error || ''), JSON.stringify(res.body));

reset();
appData.bookings[0].status = 'charged';
res = await doMove({ token: 'psess', bookingId: 'b1', newDate: '2099-03-06', newTime: '14:00' });
check('a charged session is sent to Heshy rather than moved', res.statusCode === 400 && /contact Heshy/i.test(res.body?.error || ''),
      JSON.stringify(res.body));

// The cutoff applies to where the session is NOW — otherwise a client an hour from their session
// could sidestep the cancellation notice period by moving it instead of cancelling it.
reset();
const imminent = etWallClock(60 * 60 * 1000);   // one hour away, inside the 3-hour cutoff
appData.bookings[0].date = imminent.date;
appData.bookings[0].time = imminent.time;
res = await doMove({ token: 'psess', bookingId: 'b1', newDate: '2099-03-06', newTime: '14:00' });
check('a session inside the notice period cannot be moved online', res.statusCode === 400 && /3 hours in advance/.test(res.body?.error || ''),
      JSON.stringify(res.body));

// --- in-person moves pick up that day's address ----------------------------------------------------------
reset();
appData.bookings[0].type = 'in-person';
appData.overrides = [{ id: 'o1', date: '2099-03-06', type: 'in-person', start: '09:00', end: '17:00', address: '9 Elsewhere Ave' }];
res = await doMove({ token: 'psess', bookingId: 'b1', newDate: '2099-03-06', newTime: '14:00' });
check('an in-person move resolves that date\'s own address', appData.bookings[0].location === '9 Elsewhere Ave', appData.bookings[0].location);
check('...and sends it to the calendar', calendarCalls[0]?.body?.location === '9 Elsewhere Ave');

reset();
res = await doMove({ token: 'psess', bookingId: 'b1', newDate: '2099-03-06', newTime: '14:00' });
check('a video session is given no address', appData.bookings[0].location === '', JSON.stringify(appData.bookings[0].location));

// --- the calendar failing never loses the move -------------------------------------------------------------
reset();
calendarPatchOk = false; calendarPatchStatus = 404;
res = await doMove({ token: 'psess', bookingId: 'b1', newDate: '2099-03-06', newTime: '14:00' });
check('a deleted calendar event is replaced rather than left missing',
      calendarCalls.some(c => c.method === 'POST'), JSON.stringify(calendarCalls.map(c => c.method)));
check('...and the new event id is stored', appData.bookings[0].calendarEventId === 'ev-new', appData.bookings[0].calendarEventId);
check('...along with the new meeting link', appData.bookings[0].meetLink === 'https://meet.example/new');
check('...and it is said out loud', /old calendar event was gone/i.test(res.body?.warning || ''), res.body?.warning);
check('...while the move itself still stands', appData.bookings[0].date === '2099-03-06' && res.statusCode === 200);

reset();
calendarPatchOk = false; calendarPatchStatus = 500;
res = await doMove({ token: 'psess', bookingId: 'b1', newDate: '2099-03-06', newTime: '14:00' });
check('a calendar error is reported, not hidden', !!res.body?.warning, JSON.stringify(res.body));
check('...and the move is still saved', appData.bookings[0].date === '2099-03-06');

reset();
hasGoogle = false;
store.delete('google-refresh-token');
res = await doMove({ token: 'psess', bookingId: 'b1', newDate: '2099-03-06', newTime: '14:00' });
check('no Google connection is said plainly', /not connected/i.test(res.body?.warning || ''), res.body?.warning);
check('...and the move still happens', appData.bookings[0].date === '2099-03-06' && res.statusCode === 200);

// --- the shared helpers -------------------------------------------------------------------------------------
reset();
check('addMinutes rolls over an hour', addMinutes('2099-03-06', '14:30', 60).time === '15:30');
check('...and a day', addMinutes('2099-03-06', '23:30', 60).date === '2099-03-07');
check('...and a month end', addMinutes('2099-03-31', '23:30', 60).date === '2099-04-01');
check('resolveAddress prefers a one-off override for that date',
      resolveAddress({ ...appData, overrides: [{ date: '2099-03-06', type: 'in-person', address: 'Override Ave' }] }, '2099-03-06') === 'Override Ave');
check('...then the weekly rule', resolveAddress(appData, '2099-03-06') === '123 Main St, Boro Park');
check('...then the general setting',
      resolveAddress({ ...appData, availability: { virtual: [], 'in-person': [] } }, '2099-03-06') === 'Default office');

// --- the admin path still works, through the same helper --------------------------------------------------------
reset();
res = mockRes();
await adminHandler({ method: 'POST', query: {}, headers: { 'x-admin-token': 'tok' },
  body: { action: 'reschedule-booking', bookingId: 'b1', newDate: '2099-03-06', newTime: '14:00' } }, res);
check('Heshy can still move a session', res.statusCode === 200, `${res.statusCode} ${JSON.stringify(res.body)}`);
check('...and it moves', appData.bookings[0].date === '2099-03-06' && appData.bookings[0].time === '14:00');
check('...with the calendar patched once', calendarCalls.filter(c => c.method === 'PATCH').length === 1);
const adminMail = sent.find(s => s.to === 'rivka@example.com');
check('...and the client told it was Heshy who moved it', /Heshy has moved/.test(adminMail?.html || ''),
      (adminMail?.html || '').slice(0, 300));
check('...and Heshy is not emailed about his own change', !sent.some(s => s.to === 'heshy@catalystconsultingnyc.com'));

// An admin is not held to the client notice period. Rather than depend on what hour the test
// happens to run at, the notice period is set absurdly long: the same slot is then "too soon"
// for a client and fine for Heshy, which is exactly the branch being checked.
reset();
appData.settings.minLeadHours = 700000;
res = await doMove({ token: 'psess', bookingId: 'b1', newDate: '2099-03-06', newTime: '14:00' });
check('...a time a client is refused for being too soon', res.statusCode === 400 && /too soon/i.test(res.body?.error || ''),
      JSON.stringify(res.body));
check('...and that refusal moves nothing', appData.bookings[0].time === '11:00');
res = mockRes();
await adminHandler({ method: 'POST', query: {}, headers: { 'x-admin-token': 'tok' },
  body: { action: 'reschedule-booking', bookingId: 'b1', newDate: '2099-03-06', newTime: '14:00' } }, res);
check('an admin move is not subject to the client notice period', res.statusCode === 200, JSON.stringify(res.body));
check('...and it moves', appData.bookings[0].date === '2099-03-06' && appData.bookings[0].time === '14:00');

// --- syncCalendarMove on its own -------------------------------------------------------------------------------
reset();
const noToken = await syncCalendarMove({ accessToken: null, booking: { id: 'x', calendarEventId: 'e' }, date: '2099-03-06', time: '14:00', durationMin: 60, location: '' });
check('syncCalendarMove says so when there is no Google token', /not connected/i.test(noToken.warning || ''), noToken.warning);
check('...and keeps the existing event id rather than dropping it', noToken.calendarEventId === 'e');

// --- the templates ---------------------------------------------------------------------------------------------
const bk = { id: 'b1', date: '2099-03-06', time: '14:00', durationMin: 60, type: 'virtual', clientName: 'Rivka Stern', clientId: 'c1' };
const prev = { date: '2099-03-04', time: '11:00', type: 'virtual' };
check('the client email greets them by first name', /Hi Rivka/.test(rescheduledEmail(bk, prev, {}, { by: 'client' }).html));
check('a client-initiated move does not claim Heshy did it',
      !/Heshy has moved/.test(rescheduledEmail(bk, prev, {}, { by: 'client' }).html));
check('a move by Heshy still says so', /Heshy has moved/.test(rescheduledEmail(bk, prev, {}).html));
check('the subjects differ so the two are not confused',
      rescheduledEmail(bk, prev, {}, { by: 'client' }).subject !== rescheduledEmail(bk, prev, {}).subject);
check('a client name with markup is escaped',
      !clientRescheduledAlertEmail({ ...bk, clientName: '<script>y</script>' }, prev).html.includes('<script>y'));
check('a 15-minute session is described as a phone call in the alert',
      /Phone call/.test(clientRescheduledAlertEmail({ ...bk, durationMin: 15 }, prev).html));

// --- the page ----------------------------------------------------------------------------------------------------
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
check('the portal offers a way to move a session', /data-start-move="/.test(html));
check('...alongside cancelling, not instead of it', /data-start-cancel="/.test(html));
check('...and sends the right action', /action: 'reschedule-booking'/.test(html));
check('...with the chosen date and time', /newDate: portalMoveDay, newTime: portalMoveTime/.test(html));
check('the picker is only built when asked for', /portalMovingId = bookingId/.test(html));
// The confirm button shipped once with no handler at all: it rendered, it enabled, and clicking
// it did nothing. Every control the picker draws is checked against a handler here.
for (const attr of ['data-start-move', 'data-abort-move', 'data-confirm-move', 'data-move-day', 'data-move-time']) {
  check(`"${attr}" is rendered`, new RegExp(attr + '[="]').test(html));
  check(`...and wired to something`, new RegExp(`querySelectorAll\\('\\[${attr}\\]'\\)`).test(html), attr);
}
check('the portal loads open hours before offering times', /await loadPublicState\(\)/.test(html));
check('...which the booking page uses too, so they cannot drift apart',
      (html.match(/loadPublicState\(\)/g) || []).length >= 3, String((html.match(/loadPublicState\(\)/g) || []).length));
// The session being moved occupies its own slot twice over. Leaving either in place would hide
// every time overlapping the client's current one.
check('the session being moved stops blocking itself in the booking list', /state\.bookings = \(savedBookings\|\|\[\]\)\.filter/.test(html));
check('...and in the calendar busy list', /calendarBusy = \(savedBusy\|\|\[\]\)\.filter/.test(html));
check('...and the real lists are put back afterwards', /finally \{\s*\n\s*state\.bookings = savedBookings;/.test(html));
check('the time it is already booked for is not offered', /ds === booking\.date && t === booking\.time/.test(html));
check('the picker keeps the same length and format', /Same \$\{b\.durationMin\|\|60\} minutes, same format/.test(html));
check('a session inside the cutoff says moving needs a call, not just cancelling',
      /please contact Heshy directly to move or cancel it/.test(html));
check('the picker says so when there is nothing else open', /no other open times/.test(html));
check('a successful move is confirmed on screen', /Your session has moved\. A confirmation is on its way\./.test(html));
check('the stale open-hours snapshot is dropped after a move', /portalSlotsLoaded = false;/.test(html));
check('logging out clears the half-finished move', /portalMovingId = null; portalMoveDay = null; portalMoveTime = null;/.test(html));
check('the day defaulted to in the strip is pinned before submitting',
      /portal-move-day\.selected/.test(html));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILURES:\n' + failures.map(f => '  ' + f).join('\n')); process.exit(1); }
