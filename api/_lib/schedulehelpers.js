// Shared scheduling helpers, used by both the admin reschedule and the client one. They were
// defined inside admin-data.js, where the portal could not reach them.

// dowOf already lives with the availability check, which is the other place that has to agree
// about what day a date falls on. Importing it keeps a single definition rather than a third copy.
import { dowOf } from './availability.js';
import { APP_TIMEZONE } from './time.js';

/** The address a client should be given for an in-person session on a particular date. */
export function resolveAddress(data, date) {
  const override = (data.overrides || []).find(o => o.date === date && o.type === 'in-person' && o.address);
  if (override) return override.address;
  const weekday = dowOf(date);
  const rule = (data.availability?.['in-person'] || []).find(r => r.days.includes(weekday) && r.address);
  if (rule) return rule.address;
  return data.settings?.location || '';
}

// Date/time after adding minutes, using UTC arithmetic purely as scratch math (never converted
// to a real timezone) so it is deterministic wherever the server happens to run.
export function addMinutes(dateStr, timeStr, minutesToAdd) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi));
  dt.setUTCMinutes(dt.getUTCMinutes() + minutesToAdd);
  const pad = n => String(n).padStart(2, '0');
  return {
    date: dt.getUTCFullYear() + '-' + pad(dt.getUTCMonth() + 1) + '-' + pad(dt.getUTCDate()),
    time: pad(dt.getUTCHours()) + ':' + pad(dt.getUTCMinutes())
  };
}

/**
 * Moves a booking's Google Calendar event to a new time, creating a replacement if the original
 * is gone. Admin moves and client moves have to behave identically here — a calendar that still
 * shows the old time is the same problem whoever pressed the button — so the logic lives once.
 *
 * Best-effort by design: a calendar failure never blocks the move itself. It comes back as a
 * warning so the caller can say so plainly instead of silently showing the wrong time.
 *
 * @returns {{calendarEventId: string|null, meetLink: string, warning: string|null}}
 */
export async function syncCalendarMove({ accessToken, booking, date, time, durationMin, location }) {
  let calendarEventId = booking.calendarEventId || null;
  let meetLink = booking.meetLink || '';

  if (!accessToken) {
    return { calendarEventId, meetLink, warning: 'Session moved, but Google Calendar is not connected — the calendar still shows the old time.' };
  }

  let warning = null;
  try {
    const endAt = addMinutes(date, time, durationMin);
    const start = { dateTime: date + 'T' + time + ':00', timeZone: APP_TIMEZONE };
    const end = { dateTime: endAt.date + 'T' + endAt.time + ':00', timeZone: APP_TIMEZONE };

    let patched = false;
    if (booking.calendarEventId) {
      const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${booking.calendarEventId}?sendUpdates=all`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ start, end, location })
      });
      patched = r.ok;
      if (!r.ok && r.status !== 404 && r.status !== 410) {
        const body = await r.text().catch(() => '');
        console.error('Calendar patch failed:', r.status, body.slice(0, 300));
        warning = 'Session moved, but updating the Google Calendar event failed — please check the calendar.';
      }
    }

    // No event id, or the event was deleted straight out of Google Calendar (404/410). A failed
    // patch used to be swallowed with nothing created, so the session vanished from the calendar
    // while the app still showed it.
    if (!patched) {
      const evRes = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          summary: 'Clarity session — ' + (booking.clientName || ''),
          location,
          start, end,
          attendees: booking.clientEmail ? [{ email: booking.clientEmail }] : [],
          conferenceData: { createRequest: { requestId: booking.id + '-' + Date.now(), conferenceSolutionKey: { type: 'hangoutsMeet' } } }
        })
      });
      if (evRes.ok) {
        const ev = await evRes.json();
        if (ev.id) calendarEventId = ev.id;
        if (ev.hangoutLink) meetLink = ev.hangoutLink;
        if (booking.calendarEventId) warning = 'The old calendar event was gone, so a new one was created at the new time.';
      } else {
        const body = await evRes.text().catch(() => '');
        console.error('Calendar create-on-reschedule failed:', evRes.status, body.slice(0, 300));
        warning = 'Session moved, but it could not be added to Google Calendar — please add it manually.';
      }
    }
  } catch (e) {
    console.error('Calendar sync on reschedule failed:', e);
    warning = 'Session moved, but syncing Google Calendar failed — please check the calendar.';
  }

  return { calendarEventId, meetLink, warning };
}
