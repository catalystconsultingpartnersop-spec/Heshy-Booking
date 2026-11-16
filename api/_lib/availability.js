// The authoritative "is this slot actually free?" check.
//
// Shared by new bookings and by admin rescheduling so the two can never disagree. The browser
// computes the same thing to decide what to offer, but that is only for showing good options —
// this is the boundary that actually decides.

import { etToUtc } from './time.js';

export function timeToMin(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }
export function dowOf(dateStr) { const [y, mo, d] = dateStr.split('-').map(Number); return new Date(Date.UTC(y, mo - 1, d)).getUTCDay(); }

/**
 * @param {object} data        the whole app record
 * @param {object} opts
 *   date, time, durationMin, type          the slot being requested
 *   excludeBookingId   ignore this booking when looking for clashes (used when moving it)
 *   calendarBusyRanges [[startMin,endMin]] on the Eastern wall clock, or null if unavailable
 *   requireLeadTime    false for admin actions, which aren't subject to the client notice period
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function checkSlot(data, opts) {
  const {
    date, time, durationMin, type,
    excludeBookingId = null, calendarBusyRanges = null, requireLeadTime = true
  } = opts;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return { ok: false, reason: 'That date looks wrong.' };
  if (!/^\d{2}:\d{2}$/.test(String(time || ''))) return { ok: false, reason: 'That time looks wrong.' };
  const dur = Number(durationMin);
  if (!Number.isFinite(dur) || dur <= 0 || dur > 12 * 60) return { ok: false, reason: 'That session length looks wrong.' };
  // Reject a date string that isn't a real calendar date (e.g. 2026-02-31).
  const [yy, mm, dd] = date.split('-').map(Number);
  const probe = new Date(Date.UTC(yy, mm - 1, dd));
  if (probe.getUTCFullYear() !== yy || probe.getUTCMonth() !== mm - 1 || probe.getUTCDate() !== dd) {
    return { ok: false, reason: 'That date does not exist.' };
  }

  const slotStart = etToUtc(date, time);

  if (requireLeadTime) {
    const minLeadHours = (data.settings?.minLeadHours != null) ? data.settings.minLeadHours : 12;
    const cutoff = new Date(Date.now() + minLeadHours * 60 * 60 * 1000);
    if (slotStart < cutoff) return { ok: false, reason: 'That time is too soon to book online.' };
  } else {
    // Admin moves still can't land in the past.
    if (slotStart.getTime() < Date.now()) return { ok: false, reason: 'That time is in the past.' };
  }

  const weekday = dowOf(date);
  const windows = [];
  const isBlocked = (data.blockedDates || []).some(bl => bl.date === date && bl.type === type);
  if (!isBlocked) {
    (data.availability?.[type] || [])
      .filter(r => r.days.includes(weekday))
      .forEach(r => windows.push([timeToMin(r.start), timeToMin(r.end)]));
  }
  (data.overrides || [])
    .filter(o => o.date === date && o.type === type)
    .forEach(o => windows.push([timeToMin(o.start), timeToMin(o.end)]));
  if (windows.length === 0) return { ok: false, reason: 'Nothing is open on that date.' };

  const reqStart = timeToMin(time), reqEnd = reqStart + dur;
  if (!windows.some(([ws, we]) => reqStart >= ws && reqEnd <= we)) {
    return { ok: false, reason: 'That time is outside your open hours for that date.' };
  }

  // Every active booking blocks, regardless of format. Heshy can't be on a video call and in
  // his office at the same time, and previously only same-format bookings clashed — so an
  // online session and an in-person session could be booked into the same hour whenever the
  // Google Calendar check was unavailable.
  const clash = (data.bookings || [])
    .filter(b => b.id !== excludeBookingId && b.date === date && !b.cancelled)
    .find(b => {
      const bs = timeToMin(b.time), be = bs + (b.durationMin || 60);
      return reqStart < be && reqEnd > bs;
    });
  if (clash) return { ok: false, reason: 'Another session is already booked at that time.' };

  if (calendarBusyRanges && calendarBusyRanges.some(([bs, be]) => reqStart < be && reqEnd > bs)) {
    return { ok: false, reason: 'That time is blocked on your Google Calendar.' };
  }

  return { ok: true };
}

// Back-compatible boolean form, for the booking path that only needs yes/no.
export function isRangeAvailable(data, date, time, durationMin, type, excludeBookingId, calendarBusyRanges) {
  return checkSlot(data, { date, time, durationMin, type, excludeBookingId, calendarBusyRanges }).ok;
}
