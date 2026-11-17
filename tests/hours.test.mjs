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
check('the running total is confirmed back in minutes', /Billing <strong>\$\{minsShown\} minutes<\/strong>/.test(html));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILURES:\n' + failures.map(f => '  ' + f).join('\n')); process.exit(1); }
