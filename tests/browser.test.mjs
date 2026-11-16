// Extracts the browser's real time helpers out of public/index.html and checks that they
// agree with the server module exactly. A drift between the two is what produces "the page
// offered me a slot the server then refused".
import { readFileSync } from 'node:fs';
import * as server from '../api/_lib/time.js';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

const start = html.indexOf('const APP_TZ =');
const end = html.indexOf('function slotOverlapsBusy');
if (start < 0 || end < 0 || end <= start) { console.error('Could not locate browser helpers'); process.exit(1); }
const snippet = html.slice(start, end);

// Also pull in isFutureSlot + computeFreeRanges deps that we exercise below.
const src = snippet + '\nexport { etToUtcC, etPartsOfC, busyRangesForDateC, etTodayC };';
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

let pass = 0, fail = 0; const failures = [];
function check(name, a, b) {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; failures.push(`${name}\n    server ${JSON.stringify(b)}\n    browser ${JSON.stringify(a)}`); }
}

// --- browser vs server, every day of 2026 and 2027, several times a day ---
let mismatches = 0, compared = 0;
for (let d = new Date(Date.UTC(2026, 0, 1)); d < new Date(Date.UTC(2028, 0, 1)); d = new Date(d.getTime() + 86400000)) {
  const ds = d.toISOString().slice(0, 10);
  for (const t of ['00:00', '08:45', '11:00', '12:30', '16:15', '23:45']) {
    compared++;
    if (mod.etToUtcC(ds, t).getTime() !== server.etToUtc(ds, t).getTime()) { mismatches++; if (mismatches < 4) failures.push(`etToUtc drift at ${ds} ${t}`); }
  }
}
check(`etToUtc identical across ${compared} date/time pairs`, mismatches, 0);

// --- busy-range conversion agrees, including the cases that broke before ---
const cases = [
  { busy: [{ start: '2026-11-16T16:00:00Z', end: '2026-11-16T17:00:00Z' }], date: '2026-11-16' }, // winter 11am
  { busy: [{ start: '2026-08-27T15:00:00Z', end: '2026-08-27T16:00:00Z' }], date: '2026-08-27' }, // summer 11am
  { busy: [{ start: '2026-11-16T03:00:00Z', end: '2026-11-16T07:00:00Z' }], date: '2026-11-16' }, // spans into day
  { busy: [{ start: '2026-11-16T05:00:00Z', end: '2026-11-17T05:00:00Z' }], date: '2026-11-16' }, // all day
  { busy: [{ start: '2026-11-15T16:00:00Z', end: '2026-11-15T17:00:00Z' }], date: '2026-11-16' }, // other day
  { busy: [{ start: '2026-11-01T04:30:00Z', end: '2026-11-01T06:30:00Z' }], date: '2026-11-01' }, // across fall-back
  { busy: [{ start: '2027-03-14T06:00:00Z', end: '2027-03-14T08:00:00Z' }], date: '2027-03-14' }, // across spring-fwd
  { busy: [], date: '2026-11-16' },
];
cases.forEach((c, i) => check(`busy case ${i + 1} (${c.date})`,
  mod.busyRangesForDateC(c.busy, c.date), server.busyRangesForDate(c.busy, c.date)));

// --- etTodayC must match the server's idea of the Eastern date ---
const serverToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
check('etTodayC matches ET today', mod.etTodayC(), serverToday);

// --- and it must stay right when the process pretends to be elsewhere ---
check('etTodayC is a valid ISO date', /^\d{4}-\d{2}-\d{2}$/.test(mod.etTodayC()), true);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILURES:\n' + failures.map(f => '  ' + f).join('\n')); process.exit(1); }
