// Recording how long a session actually ran.
//
// The only way to record a length was the Start/Stop timer, which nobody runs through an
// in-person client meeting — and a stray tap of Start then Stop floors to 1 minute, so a
// two-hour meeting showed as "Actual time tracked: 1 min". The hours box was typeable, but any
// re-render threw the typed value away.
//
// parseHours is lifted out of the page and run directly: a misread length is a wrong invoice,
// which is not a small mistake.
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0; const failures = [];
function check(name, cond, detail='') { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n    ' + detail : '')); } }

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

// Pull the real function out of the shipped page rather than copying it into the test, so this
// can never pass against a version that isn't the one running.
const src = html.slice(html.indexOf('function parseHours('));
const body = src.slice(0, src.indexOf('\n}\n') + 3);
check('parseHours was found in the page', body.startsWith('function parseHours(') && body.length < 1200, String(body.length));
const parseHours = new Function(body + '; return parseHours;')();

const near = (a, b) => a != null && Math.abs(a - b) < 1e-9;

// --- decimal hours, the obvious case ------------------------------------------------------------
check('"1.5" is an hour and a half', near(parseHours('1.5'), 1.5));
check('"2" is two hours', near(parseHours('2'), 2));
check('"0.25" is a quarter hour', near(parseHours('0.25'), 0.25));
check('"1.5h" works too', near(parseHours('1.5h'), 1.5));

// --- clock form, which the same person writes on the same day -------------------------------------
check('"1:30" is an hour and a half', near(parseHours('1:30'), 1.5));
check('"0:45" is three quarters', near(parseHours('0:45'), 0.75));
check('"2:05" is two hours five', near(parseHours('2:05'), 2 + 5/60));
check('"2:5" is read as two hours five, not two hours fifty', near(parseHours('2:5'), 2 + 5/60));
check('spaces around the colon are tolerated', near(parseHours('1 : 30'), 1.5));

// --- the other ways people write it ----------------------------------------------------------------
check('"90m" is an hour and a half', near(parseHours('90m'), 1.5));
check('"90 min" too', near(parseHours('90 min'), 1.5));
check('"2h15" is two and a quarter', near(parseHours('2h15'), 2.25));
check('"2h" is two hours', near(parseHours('2h'), 2));
check('capitals are fine', near(parseHours('2H15'), 2.25));
check('surrounding spaces are fine', near(parseHours('  1.5  '), 1.5));

// --- what must NOT be guessed at ---------------------------------------------------------------------
// Returning a number for these would silently bill the wrong amount, which is the whole risk here.
for (const bad of ['', '   ', 'abc', 'an hour', '1:75', '1.2.3', '-2', '1:', ':30', 'h', '1-2']) {
  check(`"${bad}" is refused rather than guessed`, parseHours(bad) === null, String(parseHours(bad)));
}
check('null is refused', parseHours(null) === null);
check('undefined is refused', parseHours(undefined) === null);

// --- what the money works out to ------------------------------------------------------------------------
const at = (v, rate=500) => Math.round(parseHours(v) * rate * 100) / 100;
check('1:30 at $500/hr is $750', at('1:30') === 750, String(at('1:30')));
check('90m at $500/hr is also $750', at('90m') === 750, String(at('90m')));
check('2h15 at $500/hr is $1125', at('2h15') === 1125, String(at('2h15')));
check('the two ways of writing the same length agree', at('1.5') === at('1:30'), `${at('1.5')} vs ${at('1:30')}`);

// --- the page keeps what was typed ---------------------------------------------------------------------
check('a typed length is remembered across renders', /billedHoursDraft\[id\] = el\.value/.test(html));
check('...and the box prefers it over the timer\'s number', /const hoursShown = \(draft !== undefined\) \? draft/.test(html));
check('...and the amount follows from it', /const amt = \(draft !== undefined && amtFromHours != null\)/.test(html));
check('...and it is dropped only once the charge has gone through', /delete billedHoursDraft\[id\];/.test(html));
check('the box accepts the clock form', /parseHours\(el\.value\)/.test(html));
check('...and the charge uses the same parsing', /parseHours\(hoursInput\.value\)/.test(html));
// Charging the default when Heshy meant to type a length would bill the wrong amount in silence.
check('an unreadable length stops the charge rather than billing a default',
      /isn't a length I can read/.test(html));
check('...and says how to write it', /Try 1\.5, or 1:30, or 90m/.test(html));

// --- no more pretending a timer ran ----------------------------------------------------------------------
check('the page distinguishes a recorded length from a fallback', /const timeRecorded = typeof b\.actualMinutes === 'number' && b\.actualMinutes > 0/.test(html));
check('...and says so plainly when nothing was recorded', /No time was recorded for this session/.test(html));
check('...rather than calling the booked length "tracked"', !/Actual time tracked/.test(html));
// With no recorded time, "Actual time (1 min)" vs "At least booked" is a meaningless choice.
check('the bill-for toggle is hidden when there is nothing to compare', /\$\{timeRecorded \? `\s*\n\s*<label>Bill for<\/label>/.test(html));
check('the running total is confirmed back in minutes', /Billing <strong>\$\{minsShown\} \$\{minsShown===1\?'minute':'minutes'\}<\/strong>/.test(html));
// Each basis button has to show its own number. "At least booked" was showing the figure for
// whichever basis happened to be selected, so a 1-minute reading made it read "(1 min)" when it
// would actually bill the 60 booked.
check('the "at least booked" option shows what it would bill, not the other option\'s figure',
      /At least booked \(\$\{Math\.max\(b\.durationMin, actualMins\)\} min\)/.test(html));
check('...while "actual time" shows the recorded figure', /Actual time \(\$\{actualMins\} min\)/.test(html));

// --- typing the length in, next to the timer ---------------------------------------------------
// Heshy's point: the length belongs where the timer is. The billing box further down was
// editable, but he had no reason to expect that, and for a meeting held away from the laptop the
// timer is useless.
check('there is a way to enter the length by hand', /data-edit-actual="/.test(html));
check('...labelled as such, next to Start', /Enter manually/.test(html));
check('...offered only when the timer is not running', /\$\{running \? '' : `<button class="ghost small" data-edit-actual/.test(html));
check('...asking in plain words', /How long did it actually run\?/.test(html));
check('...and showing the formats it takes', /1:30, 90m or 1\.5/.test(html));
check('the entry saves to the booking itself', /data-save-actual="/.test(html) && /saveActualTime/.test(html));
check('...writing actual minutes', /updateBooking\(id, \{ actualMinutes: mins \}\)/.test(html));
check('Enter saves it, without reaching for the mouse', /ev\.key === 'Enter'[\s\S]{0,120}saveActualTime/.test(html));
check('an unreadable length is refused rather than guessed', /isn't a length I can read\. Try 1:30, 90m or 1\.5/.test(html));
check('...and zero is refused too, with Clear offered instead', /no time at all. Use Clear to remove it/.test(html));
check('a recorded length can be cleared back to nothing', /data-clear-actual="/.test(html));
check('...by storing zero, which the billing box reads as "not recorded"', /clearActualTime[\s\S]{0,260}actualMinutes: 0/.test(html));
check('a stale figure in the billing box is dropped when the length changes',
      (html.match(/delete billedHoursDraft\[id\];/g) || []).length >= 3,
      String((html.match(/delete billedHoursDraft\[id\];/g) || []).length));

// Reopening the box should show what was typed, not a decimal to re-read.
const src2 = html.slice(html.indexOf('function minutesToHm('));
const mToHm = new Function(src2.slice(0, src2.indexOf('\n}\n') + 3) + '; return minutesToHm;')();
check('90 minutes reads back as 1:30', mToHm(90) === '1:30', mToHm(90));
check('60 minutes reads back as 1', mToHm(60) === '1', mToHm(60));
check('135 minutes reads back as 2:15', mToHm(135) === '2:15', mToHm(135));
check('45 minutes reads back as 0:45', mToHm(45) === '0:45', mToHm(45));
check('what reads back can be read again', parseHours(mToHm(135)) === 2.25, String(parseHours(mToHm(135))));
check('...for an exact number of hours too', parseHours(mToHm(120)) === 2);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILURES:\n' + failures.map(f => '  ' + f).join('\n')); process.exit(1); }
