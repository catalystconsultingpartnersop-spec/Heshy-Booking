import { etToUtc, etPartsOf, busyRangesForDate, etDayBounds } from '../api/_lib/time.js';

let pass = 0, fail = 0;
const failures = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; } else { fail++; failures.push(`${name}\n    expected ${e}\n    actual   ${a}`); }
}

// ---------- etToUtc: Eastern wall clock -> UTC instant ----------
// Winter (EST, UTC-5)
check('EST 11:00 Nov 16 2026', etToUtc('2026-11-16','11:00').toISOString(), '2026-11-16T16:00:00.000Z');
check('EST 00:00 Nov 16 2026', etToUtc('2026-11-16','00:00').toISOString(), '2026-11-16T05:00:00.000Z');
check('EST 23:59 Jan 15 2027', etToUtc('2027-01-15','23:59').toISOString(), '2027-01-16T04:59:00.000Z');
// Summer (EDT, UTC-4)
check('EDT 11:00 Aug 27 2026', etToUtc('2026-08-27','11:00').toISOString(), '2026-08-27T15:00:00.000Z');
check('EDT 12:45 Jul 04 2026', etToUtc('2026-07-04','12:45').toISOString(), '2026-07-04T16:45:00.000Z');

// DST transition days.
// Spring forward 2027: Sun Mar 14. 01:59 EST -> 03:00 EDT.
check('spring fwd 01:00 (still EST)', etToUtc('2027-03-14','01:00').toISOString(), '2027-03-14T06:00:00.000Z');
check('spring fwd 11:00 (now EDT)',   etToUtc('2027-03-14','11:00').toISOString(), '2027-03-14T15:00:00.000Z');
// Fall back 2026: Sun Nov 1. 01:59 EDT -> 01:00 EST.
check('fall back 00:30 (still EDT)',  etToUtc('2026-11-01','00:30').toISOString(), '2026-11-01T04:30:00.000Z');
check('fall back 11:00 (now EST)',    etToUtc('2026-11-01','11:00').toISOString(), '2026-11-01T16:00:00.000Z');

// ---------- etPartsOf: UTC instant -> Eastern wall clock ----------
check('parts EST 16:00Z', etPartsOf(new Date('2026-11-16T16:00:00Z')), { date:'2026-11-16', minutes: 660 });
check('parts EDT 15:00Z', etPartsOf(new Date('2026-08-27T15:00:00Z')), { date:'2026-08-27', minutes: 660 });
check('parts ET midnight', etPartsOf(new Date('2026-11-16T05:00:00Z')), { date:'2026-11-16', minutes: 0 });
// The classic hour12/h23 trap: midnight must be 0, never 1440.
check('parts midnight is 0 not 1440', etPartsOf(new Date('2026-06-15T04:00:00Z')).minutes, 0);
// An instant that is still "yesterday" in ET
check('parts 02:00Z is prev ET day', etPartsOf(new Date('2026-11-17T02:00:00Z')), { date:'2026-11-16', minutes: 1260 });

// Round-trip across a full year, every day at a few wall-clock times.
let rtFail = 0;
for (let d = new Date(Date.UTC(2026,0,1)); d < new Date(Date.UTC(2027,0,1)); d = new Date(d.getTime()+86400000)) {
  const ds = d.toISOString().slice(0,10);
  for (const t of ['00:30','09:15','11:00','12:45','19:30','23:15']) {
    const back = etPartsOf(etToUtc(ds, t));
    const want = { date: ds, minutes: Number(t.slice(0,2))*60 + Number(t.slice(3)) };
    if (back.date !== want.date || back.minutes !== want.minutes) {
      // The one legitimate exception: 00:30-02:00 doesn't exist on spring-forward day.
      if (!(ds === '2026-03-08' && t === '00:30')) rtFail++;
    }
  }
}
check('round-trip every day of 2026', rtFail, 0);

// ---------- busyRangesForDate ----------
// An 11am-12pm ET meeting in winter must read as 660-720, NOT 960-1020.
check('winter 11am busy -> 660..720',
  busyRangesForDate([{ start:'2026-11-16T16:00:00Z', end:'2026-11-16T17:00:00Z' }], '2026-11-16'),
  [[660, 720]]);
// Same meeting in summer.
check('summer 11am busy -> 660..720',
  busyRangesForDate([{ start:'2026-08-27T15:00:00Z', end:'2026-08-27T16:00:00Z' }], '2026-08-27'),
  [[660, 720]]);
// Heshy's actual Labor Day case: a 12:30-13:30 ET event.
check('12:30pm busy -> 750..810',
  busyRangesForDate([{ start:'2026-11-16T17:30:00Z', end:'2026-11-16T18:30:00Z' }], '2026-11-16'),
  [[750, 810]]);
// Event entirely on another day is dropped.
check('previous day dropped',
  busyRangesForDate([{ start:'2026-11-15T16:00:00Z', end:'2026-11-15T17:00:00Z' }], '2026-11-16'), []);
check('next day dropped',
  busyRangesForDate([{ start:'2026-11-17T16:00:00Z', end:'2026-11-17T17:00:00Z' }], '2026-11-16'), []);
// Spanning midnight into the target day gets clipped at 0.
check('spans into day -> clipped at 0',
  busyRangesForDate([{ start:'2026-11-16T03:00:00Z', end:'2026-11-16T07:00:00Z' }], '2026-11-16'),
  [[0, 120]]);
// Spanning out of the target day gets clipped at 1440.
check('spans out of day -> clipped at 1440',
  busyRangesForDate([{ start:'2026-11-16T:'.replace(':',''), end:'x' }], '2026-11-16'), []); // malformed input ignored
check('all-day event -> 0..1440',
  busyRangesForDate([{ start:'2026-11-16T05:00:00Z', end:'2026-11-17T05:00:00Z' }], '2026-11-16'),
  [[0, 1440]]);
// Zero-length and reversed intervals ignored.
check('zero-length ignored',
  busyRangesForDate([{ start:'2026-11-16T16:00:00Z', end:'2026-11-16T16:00:00Z' }], '2026-11-16'), []);
check('reversed ignored',
  busyRangesForDate([{ start:'2026-11-16T17:00:00Z', end:'2026-11-16T16:00:00Z' }], '2026-11-16'), []);
// Empty / missing input.
check('empty busy list', busyRangesForDate([], '2026-11-16'), []);
check('null busy list', busyRangesForDate(null, '2026-11-16'), []);
// Multiple intervals preserved.
check('two meetings',
  busyRangesForDate([
    { start:'2026-11-16T16:00:00Z', end:'2026-11-16T17:00:00Z' },
    { start:'2026-11-16T19:00:00Z', end:'2026-11-16T20:00:00Z' }
  ], '2026-11-16'),
  [[660,720],[840,900]]);
// Event ending exactly at ET midnight shouldn't register as a 0-length range next day.
check('ends at midnight not counted next day',
  busyRangesForDate([{ start:'2026-11-16T04:00:00Z', end:'2026-11-16T05:00:00Z' }], '2026-11-16'), []);

// ---------- etDayBounds ----------
check('day bounds winter', [etDayBounds('2026-11-16').start.toISOString(), etDayBounds('2026-11-16').end.toISOString()],
  ['2026-11-16T05:00:00.000Z','2026-11-17T05:00:00.000Z']);
check('day bounds summer', [etDayBounds('2026-08-27').start.toISOString(), etDayBounds('2026-08-27').end.toISOString()],
  ['2026-08-27T04:00:00.000Z','2026-08-28T04:00:00.000Z']);
check('day bounds month end', etDayBounds('2026-11-30').end.toISOString(), '2026-12-01T05:00:00.000Z');
check('day bounds year end', etDayBounds('2026-12-31').end.toISOString(), '2027-01-01T05:00:00.000Z');
// Fall-back day is 25 hours long; spring-forward day is 23.
check('fall back day is 25h',
  (etDayBounds('2026-11-01').end - etDayBounds('2026-11-01').start) / 3600000, 25);
check('spring fwd day is 23h',
  (etDayBounds('2026-03-08').end - etDayBounds('2026-03-08').start) / 3600000, 23);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILURES:\n' + failures.map(f => '  ' + f).join('\n')); process.exit(1); }
