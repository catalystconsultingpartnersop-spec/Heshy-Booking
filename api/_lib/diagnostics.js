// Builds a picture of the app's state that is useful for diagnosing a problem but contains no
// client personal information.
//
// The point: most questions ("are bookings getting their own Meet link?", "did that session
// save?", "how many sessions are waiting to be billed?") can be answered from shape and counts.
// Names, emails, phone numbers, session notes and addresses should not end up in a chat
// transcript just because something routine was being checked. Full records are available, but
// only when explicitly asked for, one client or booking at a time.

import { etToUtc, etPartsOf } from './time.js';

const present = v => !!(v && String(v).trim());

// Keeps enough of a URL to tell two apart without reproducing a working link.
function linkFingerprint(url) {
  if (!present(url)) return null;
  const tail = String(url).trim().replace(/\/+$/, '').split('/').pop();
  return tail ? tail.slice(0, 4) + '…' : null;
}

export function buildSummary(data) {
  const bookings = data.bookings || [];
  const clients = data.clients || [];
  const settings = data.settings || {};
  const nowDate = etPartsOf(new Date()).date;

  const active = bookings.filter(b => !b.cancelled);
  const virtual = active.filter(b => b.type === 'virtual');

  // Directly answers "is every call getting its own Meet room, or are they sharing one?"
  const links = virtual.map(b => b.meetLink).filter(present);
  const meetLinks = {
    virtualBookings: virtual.length,
    withOwnLink: links.length,
    withoutLink: virtual.length - links.length,
    distinctLinks: new Set(links).size,
    allDistinct: links.length > 0 && new Set(links).size === links.length,
    fallbackConfiguredInSettings: present(settings.meetLink),
    fallbackFingerprint: linkFingerprint(settings.meetLink)
  };

  const past = b => {
    try { return etToUtc(b.date, b.time).getTime() + ((b.durationMin || 60) * 60000) <= Date.now(); }
    catch (e) { return false; }
  };

  return {
    generatedAt: new Date().toISOString(),
    today: nowDate,
    counts: {
      clients: clients.length,
      clientsBlocked: clients.filter(c => c.blocked).length,
      bookingsTotal: bookings.length,
      bookingsActive: active.length,
      bookingsCancelled: bookings.filter(b => b.cancelled).length,
      upcoming: active.filter(b => !past(b)).length,
      charged: bookings.filter(b => b.status === 'charged').length,
      needsBilling: active.filter(b => past(b) && b.status === 'scheduled').length
    },
    meetLinks,
    integrations: {
      calendarEventsOnActiveBookings: active.filter(b => present(b.calendarEventId)).length,
      bookingsWithInternalNotes: bookings.filter(b => present(b.summary)).length,
      bookingsWithClientSummary: bookings.filter(b => present(b.clientSummary)).length,
      clientsWithCardOnFile: clients.filter(c => present(c.stripeCustomerId)).length,
      clientsWithWorkingGeniusPdf: clients.filter(c => present(c.wgPdfData)).length,
      clientsWithWorkingGeniusLetters: clients.filter(c => present(c.wgLetters)).length
    },
    settings: {
      hourlyRate: settings.hourlyRate ?? null,
      durationOptions: settings.durationOptions ?? null,
      minLeadHours: settings.minLeadHours ?? null,
      clientCancelCutoffHours: settings.clientCancelCutoffHours ?? null,
      billingMode: settings.billingMode ?? null,
      intakeQuestionCount: (settings.intakeQuestions || []).length,
      couponCount: (settings.coupons || []).length,
      hasDefaultLocation: present(settings.location),
      hasFallbackMeetLink: present(settings.meetLink)
    },
    availability: {
      virtualRules: (data.availability?.virtual || []).map(r => ({
        id: r.id, days: r.days, start: r.start, end: r.end
      })),
      inPersonRules: (data.availability?.['in-person'] || []).map(r => ({
        id: r.id, days: r.days, start: r.start, end: r.end,
        generalArea: r.generalArea || null, hasAddress: present(r.address)
      })),
      futureOverrides: (data.overrides || []).filter(o => o.date >= nowDate).length,
      futureBlockedDates: (data.blockedDates || []).filter(b => b.date >= nowDate).length
    },
    // Booking rows with no identity attached — enough to spot a pattern or a gap.
    bookings: bookings
      .slice()
      .sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time))
      .slice(0, 60)
      .map(b => ({
        id: b.id, date: b.date, time: b.time, durationMin: b.durationMin, type: b.type,
        status: b.status, cancelled: !!b.cancelled, comped: !!b.comped,
        amount: b.amount ?? null, actualMinutes: b.actualMinutes ?? null,
        hasMeetLink: present(b.meetLink), meetLinkFingerprint: linkFingerprint(b.meetLink),
        hasCalendarEvent: present(b.calendarEventId),
        hasNotes: present(b.summary), reminderSent: !!b.reminderSent,
        clientRef: b.clientId ? String(b.clientId).slice(0, 4) + '…' : null
      }))
  };
}

// Full records, for when a summary isn't enough. Asked for one at a time, on purpose.
export function buildDetail(data, { bookingId, clientId }) {
  if (bookingId) {
    const b = (data.bookings || []).find(x => x.id === bookingId);
    return b ? { booking: b } : { error: 'No booking with that id.' };
  }
  if (clientId) {
    const c = (data.clients || []).find(x => x.id === clientId);
    if (!c) return { error: 'No client with that id.' };
    return { client: c, bookings: (data.bookings || []).filter(b => b.clientId === clientId) };
  }
  return { error: 'Specify bookingId or clientId.' };
}
