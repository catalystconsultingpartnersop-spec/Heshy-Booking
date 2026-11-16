import { isRangeAvailable } from '../api/create-booking.js';
import { busyRangesForDate } from '../api/_lib/time.js';

let pass = 0, fail = 0;
const failures = [];
function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass++;
  else { fail++; failures.push(`${name}\n    expected ${JSON.stringify(expected)}  actual ${JSON.stringify(actual)}`); }
}

// A realistic copy of Heshy's setup: Mon-Thu 11:00-13:00 for both formats.
const data = {
  settings: { minLeadHours: 12 },
  availability: {
    virtual:     [{ id:'r1', days:[1,2,3,4], start:'11:00', end:'13:00' }],
    'in-person': [{ id:'r4', days:[1,2,3,4], start:'11:00', end:'13:00' }]
  },
  overrides: [], blockedDates: [], bookings: []
};
// Far enough ahead to clear the 12-hour notice rule in every case below.
const FUTURE_WED = '2027-01-20'; // a Wednesday, EST
const FUTURE_WED_SUMMER = '2027-07-21'; // a Wednesday, EDT

// --- Baseline: with no calendar at all, the windows behave ---
check('11:00 bookable, no calendar', isRangeAvailable(data, FUTURE_WED, '11:00', 60, 'virtual', null, null), true);
check('14:00 outside window',        isRangeAvailable(data, FUTURE_WED, '14:00', 60, 'virtual', null, null), false);
check('12:30 60min overruns window', isRangeAvailable(data, FUTURE_WED, '12:30', 60, 'virtual', null, null), false);
check('12:00 60min fits exactly',    isRangeAvailable(data, FUTURE_WED, '12:00', 60, 'virtual', null, null), true);

// --- An existing app booking blocks the same time ---
const withBooking = { ...data, bookings: [
  { id:'b1', date: FUTURE_WED, time:'11:00', durationMin:60, type:'virtual', cancelled:false }
]};
check('same-format overlap blocked', isRangeAvailable(withBooking, FUTURE_WED, '11:00', 60, 'virtual', null, null), false);
check('after that booking is free',  isRangeAvailable(withBooking, FUTURE_WED, '12:00', 60, 'virtual', null, null), true);
check('cancelled booking frees slot',
  isRangeAvailable({ ...data, bookings:[{ id:'b1', date:FUTURE_WED, time:'11:00', durationMin:60, type:'virtual', cancelled:true }] },
    FUTURE_WED, '11:00', 60, 'virtual', null, null), true);

// --- THE BUG: a real 11am Google Calendar event, winter ---
// 11:00 EST == 16:00 UTC.
const realBusyWinter = [{ start:`${FUTURE_WED}T16:00:00Z`, end:`${FUTURE_WED}T17:00:00Z` }];

// How the OLD code converted it: minutes after *UTC* midnight.
const oldWay = realBusyWinter.map(b => {
  const dayStart = new Date(FUTURE_WED + 'T00:00:00Z'); // server runs UTC
  return [Math.round((new Date(b.start) - dayStart)/60000), Math.round((new Date(b.end) - dayStart)/60000)];
});
check('OLD conversion puts 11am at 16:00', oldWay, [[960, 1020]]);

// How the NEW code converts it.
const newWay = busyRangesForDate(realBusyWinter, FUTURE_WED);
check('NEW conversion puts 11am at 11:00', newWay, [[660, 720]]);

// The consequence, through the real availability function:
check('BUG: old ranges leave 11:00 bookable while Heshy is busy',
  isRangeAvailable(data, FUTURE_WED, '11:00', 60, 'virtual', null, oldWay), true);
check('FIXED: new ranges block 11:00',
  isRangeAvailable(data, FUTURE_WED, '11:00', 60, 'virtual', null, newWay), false);

// Summer must behave identically (offset differs by an hour).
const realBusySummer = [{ start:`${FUTURE_WED_SUMMER}T15:00:00Z`, end:`${FUTURE_WED_SUMMER}T16:00:00Z` }];
check('summer: new ranges block 11:00',
  isRangeAvailable(data, FUTURE_WED_SUMMER, '11:00', 60, 'virtual',
    null, busyRangesForDate(realBusySummer, FUTURE_WED_SUMMER)), false);
check('summer: 12:00 still free',
  isRangeAvailable(data, FUTURE_WED_SUMMER, '12:00', 60, 'virtual',
    null, busyRangesForDate(realBusySummer, FUTURE_WED_SUMMER)), true);

// A busy block that only partly covers the window.
const partial = busyRangesForDate([{ start:`${FUTURE_WED}T16:30:00Z`, end:`${FUTURE_WED}T17:00:00Z` }], FUTURE_WED);
check('11:30-12:00 busy blocks an 11:00 hour', isRangeAvailable(data, FUTURE_WED, '11:00', 60, 'virtual', null, partial), false);
check('11:30-12:00 busy leaves 12:00 free',    isRangeAvailable(data, FUTURE_WED, '12:00', 60, 'virtual', null, partial), true);

// A calendar event outside the booking window must not block anything.
const evening = busyRangesForDate([{ start:`${FUTURE_WED}T23:00:00Z`, end:`${FUTURE_WED}T23:30:00Z` }], FUTURE_WED);
check('6pm event does not block 11:00', isRangeAvailable(data, FUTURE_WED, '11:00', 60, 'virtual', null, evening), true);

// Calendar unavailable (null) must never block — unchanged behaviour.
check('null busy = no calendar blocking', isRangeAvailable(data, FUTURE_WED, '11:00', 60, 'virtual', null, null), true);
check('empty busy = nothing blocked',     isRangeAvailable(data, FUTURE_WED, '11:00', 60, 'virtual', null, []), true);

// --- The 12-hour notice rule still works ---
const todayEt = new Intl.DateTimeFormat('en-CA', { timeZone:'America/New_York', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
check('a slot earlier today is refused', isRangeAvailable(data, todayEt, '11:00', 60, 'virtual', null, null), false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILURES:\n' + failures.map(f=>'  '+f).join('\n')); process.exit(1); }
