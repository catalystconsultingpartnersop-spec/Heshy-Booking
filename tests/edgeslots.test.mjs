// Not butchering an open stretch.
//
// A 30-minute booking dropped at 11:30 inside an 11:00-13:00 window leaves two 90-minute
// fragments, neither of which can take a 2-hour session any more. One short booking in the wrong
// place costs the whole afternoon.
//
// The booking page only ever offers two start times per free stretch — flush to the start, or
// flush to the end. But the page only decides what to SHOW. Until now the server accepted any
// time that merely fitted inside open hours, so the rule was a suggestion, not a rule.
import { checkSlot, freeRanges } from '../api/_lib/availability.js';

let pass = 0, fail = 0; const failures = [];
function check(name, cond, detail='') { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n    ' + detail : '')); } }

// A Wednesday far enough out to clear the notice period.
const DATE = '2099-03-04';
const base = () => ({
  clients: [], bookings: [],
  availability: { virtual: [{ id:'r1', days:[0,1,2,3,4,5,6], start:'11:00', end:'13:00' }], 'in-person': [] },
  overrides: [], blockedDates: [],
  settings: { hourlyRate: 500, minLeadHours: 12 }
});
const ask = (data, time, dur, extra={}) =>
  checkSlot(data, { date: DATE, time, durationMin: dur, type: 'virtual', mustHugEdge: true, ...extra });

// --- the whole point ------------------------------------------------------------------------------
let d = base();
check('a short session in the middle of an open stretch is refused', !ask(d, '11:30', 30).ok);
check('...and says why in words a person would use',
      /awkward gap/.test(ask(d, '11:30', 30).reason), ask(d, '11:30', 30).reason);
check('...11:15 too', !ask(d, '11:15', 30).ok);
check('...12:00 too, which looks tidy but still splits it', !ask(d, '12:00', 30).ok);

check('flush to the start is fine', ask(d, '11:00', 30).ok, JSON.stringify(ask(d, '11:00', 30)));
check('flush to the end is fine', ask(d, '12:30', 30).ok, JSON.stringify(ask(d, '12:30', 30)));
// A session that fills the window exactly touches both edges.
check('a session that fills the window is fine', ask(d, '11:00', 120).ok);
check('an hour at the start is fine', ask(d, '11:00', 60).ok);
check('an hour at the end is fine', ask(d, '12:00', 60).ok);
// 11:30-12:30 is dead centre: the worst case, and it was allowed before.
check('an hour dead centre is refused', !ask(d, '11:30', 60).ok);

// --- once something is booked, the fragments have their own edges ---------------------------------
d = base();
d.bookings = [{ id:'b1', date: DATE, time:'11:00', durationMin: 60, type:'virtual', status:'scheduled' }];
// Free is now 12:00-13:00 only.
check('a booking leaves a fragment with its own start edge', ask(d, '12:00', 30).ok);
check('...and its own end edge', ask(d, '12:30', 30).ok);
check('...but still nothing in the middle of it', !ask(d, '12:15', 30).ok);
check('the time already taken is refused as a clash', !ask(d, '11:00', 30).ok);
check('...with the clash named, not the gap', /already booked/.test(ask(d, '11:30', 30).reason), ask(d, '11:30', 30).reason);

// A booking in the middle creates two fragments, each with two edges.
d = base();
d.availability.virtual = [{ id:'r1', days:[0,1,2,3,4,5,6], start:'09:00', end:'17:00' }];
d.bookings = [{ id:'b1', date: DATE, time:'12:00', durationMin: 60, type:'virtual', status:'scheduled' }];
check('the morning fragment starts flush', ask(d, '09:00', 60).ok);
check('...and ends flush', ask(d, '11:00', 60).ok);
check('the afternoon fragment starts flush', ask(d, '13:00', 60).ok);
check('...and ends flush', ask(d, '16:00', 60).ok);
check('nothing floats in the morning fragment', !ask(d, '10:00', 60).ok);
check('nothing floats in the afternoon fragment', !ask(d, '14:30', 60).ok);

// --- a cancelled session frees its slot, edges and all -----------------------------------------------
d = base();
d.bookings = [{ id:'b1', date: DATE, time:'11:00', durationMin: 60, type:'virtual', status:'scheduled', cancelled: true }];
check('a cancelled session stops blocking', ask(d, '11:00', 30).ok);
check('...and the stretch is whole again', !ask(d, '11:30', 30).ok);

// --- moving a session doesn't collide with itself ------------------------------------------------------
d = base();
d.bookings = [{ id:'b1', date: DATE, time:'11:00', durationMin: 60, type:'virtual', status:'scheduled' }];
check('a session being moved does not block its own window',
      ask(d, '12:00', 60, { excludeBookingId: 'b1' }).ok);
check('...and the edge rule still applies to where it lands',
      !ask(d, '11:30', 60, { excludeBookingId: 'b1' }).ok);

// --- Heshy is not a client -----------------------------------------------------------------------------
d = base();
check('an admin can put a session wherever it is needed',
      checkSlot(d, { date: DATE, time:'11:30', durationMin: 30, type:'virtual', requireLeadTime: false }).ok);
check('...which is the same request a client is refused', !ask(d, '11:30', 30).ok);

// --- the rule never loosens anything --------------------------------------------------------------------
d = base();
check('outside open hours is still refused', !ask(d, '14:00', 30).ok);
check('a blocked date is still refused',
      !ask({ ...d, blockedDates: [{ date: DATE, type: 'virtual' }] }, '11:00', 30).ok);
check('a session running past the end is still refused', !ask(d, '12:00', 120).ok);

// Two windows that touch are one stretch, so the join is not an edge.
d = base();
d.availability.virtual = [
  { id:'r1', days:[0,1,2,3,4,5,6], start:'11:00', end:'13:00' },
  { id:'r2', days:[0,1,2,3,4,5,6], start:'13:00', end:'15:00' }
];
check('two touching windows merge into one stretch', ask(d, '11:00', 30).ok);
check('...so their join is not an edge', !ask(d, '13:00', 30).ok, JSON.stringify(ask(d, '13:00', 30)));
check('...and the far end is', ask(d, '14:30', 30).ok);

// Two windows with a gap are two stretches, each with its own edges.
d = base();
d.availability.virtual = [
  { id:'r1', days:[0,1,2,3,4,5,6], start:'09:00', end:'11:00' },
  { id:'r2', days:[0,1,2,3,4,5,6], start:'14:00', end:'16:00' }
];
check('a separate window has its own start edge', ask(d, '14:00', 30).ok);
check('...and its own end edge', ask(d, '15:30', 30).ok);
check('...and nothing in between', !ask(d, '15:00', 30).ok);
check('the gap between them is not bookable', !ask(d, '12:00', 30).ok);

// --- Google Calendar busy time carves the stretch the same way ---------------------------------------------
d = base();
d.availability.virtual = [{ id:'r1', days:[0,1,2,3,4,5,6], start:'09:00', end:'17:00' }];
const busy = [[12 * 60, 13 * 60]];
check('a calendar block leaves a fragment that starts flush',
      ask(d, '09:00', 60, { calendarBusyRanges: busy }).ok);
check('...ends flush', ask(d, '11:00', 60, { calendarBusyRanges: busy }).ok);
check('...and nothing floats inside it', !ask(d, '10:00', 60, { calendarBusyRanges: busy }).ok);
check('the far side of the block starts flush', ask(d, '13:00', 60, { calendarBusyRanges: busy }).ok);

// --- freeRanges on its own ----------------------------------------------------------------------------------
d = base();
check('a clear day is one stretch', JSON.stringify(freeRanges(d, DATE, 'virtual')) === '[[660,780]]',
      JSON.stringify(freeRanges(d, DATE, 'virtual')));
d.bookings = [{ id:'b1', date: DATE, time:'11:30', durationMin: 30, type:'virtual', status:'scheduled' }];
check('a booking in the middle makes two', freeRanges(d, DATE, 'virtual').length === 2,
      JSON.stringify(freeRanges(d, DATE, 'virtual')));
check('an in-person booking blocks an online stretch too',
      freeRanges({ ...d, bookings: [{ id:'b2', date: DATE, time:'11:30', durationMin:30, type:'in-person', status:'scheduled' }] }, DATE, 'virtual').length === 2);
check('a day with nothing open has no stretches', freeRanges(base(), '2099-03-04', 'in-person').length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILURES:\n' + failures.map(f => '  ' + f).join('\n')); process.exit(1); }
