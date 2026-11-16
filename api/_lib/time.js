// Shared Eastern-time conversions.
//
// Why this exists: Vercel's servers run in UTC, but every time in this app is an Eastern
// wall-clock time ("11:00" means 11am in New York). Mixing the two silently shifts every
// comparison by 4 or 5 hours depending on the season. The browser and the server must agree,
// so the same logic lives here and is mirrored in public/index.html.

export const APP_TIMEZONE = 'America/New_York';

// Reads a UTC instant as Eastern wall-clock fields. Deliberately uses only the oldest, most
// widely supported Intl options (no shortOffset, no hourCycle) so this cannot throw on an older
// phone browser. hour12:false reports midnight as "24" on some engines, hence the % 24.
function etFieldsAt(instant) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).formatToParts(instant);
  const p = {};
  for (const part of parts) p[part.type] = part.value;
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    hour: Number(p.hour) % 24, minute: Number(p.minute), second: Number(p.second)
  };
}

// The ET offset, in minutes, in effect at a given UTC instant. EST = -300, EDT = -240.
// Derived by reading the instant in ET and measuring how far that is from the same fields in UTC.
function etOffsetMinutesAt(instant) {
  const f = etFieldsAt(instant);
  const asUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  return Math.round((asUtc - instant.getTime()) / 60000);
}

// Eastern wall-clock date+time -> the true UTC instant.
// Resolved in two passes: the first guess uses the offset at midday UTC on that date, the second
// re-checks the offset at the guessed instant. That second pass is what makes times on either
// side of a daylight-saving switch land correctly.
export function etToUtc(date, time) {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const asIfUtc = Date.UTC(y, mo - 1, d, h, mi);
  let offset = etOffsetMinutesAt(new Date(date + 'T12:00:00Z'));
  let instant = new Date(asIfUtc - offset * 60000);
  const refined = etOffsetMinutesAt(instant);
  if (refined !== offset) instant = new Date(asIfUtc - refined * 60000);
  return instant;
}

// A UTC instant -> what the Eastern wall clock reads at that moment.
// Returns the ET calendar date and minutes past ET midnight on that date.
export function etPartsOf(instant) {
  const f = etFieldsAt(instant);
  const pad = n => String(n).padStart(2, '0');
  return {
    date: `${f.year}-${pad(f.month)}-${pad(f.day)}`,
    minutes: f.hour * 60 + f.minute
  };
}

// Today's date on the Eastern calendar.
export function etToday() {
  return etPartsOf(new Date()).date;
}

// Google free/busy intervals -> [startMinute, endMinute] ranges on one Eastern calendar date,
// measured the same way the app measures its own times (minutes on the Eastern wall clock).
// Intervals that don't touch that date are dropped; ones that straddle midnight are clipped.
export function busyRangesForDate(busy, targetDate) {
  const ranges = [];
  for (const b of busy || []) {
    const start = new Date(b.start), end = new Date(b.end);
    if (isNaN(start) || isNaN(end) || end <= start) continue;
    const s = etPartsOf(start), e = etPartsOf(end);
    if (e.date < targetDate || s.date > targetDate) continue;        // entirely on another day
    if (e.date === targetDate && e.minutes === 0) continue;          // ends exactly at midnight
    const startMin = s.date < targetDate ? 0 : s.minutes;
    const endMin = e.date > targetDate ? 24 * 60 : e.minutes;
    if (endMin > startMin) ranges.push([startMin, endMin]);
  }
  return ranges;
}

// The UTC instants bounding one Eastern calendar day, for a free/busy query window.
export function etDayBounds(date) {
  const start = etToUtc(date, '00:00');
  const [y, mo, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y, mo - 1, d + 1));
  const nextDate = next.toISOString().slice(0, 10);
  return { start, end: etToUtc(nextDate, '00:00') };
}
