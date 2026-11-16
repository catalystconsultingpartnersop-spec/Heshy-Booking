import { kv } from '@vercel/kv';
import { logError } from './_lib/errorlog.js';

function defaultAvailability() {
  return {
    virtual: [
      { id: 'r1', days: [1, 2, 3, 4], start: '11:00', end: '13:00' },
      { id: 'r2', days: [5], start: '10:30', end: '12:30' },
      { id: 'r3', days: [0], start: '10:30', end: '11:30' }
    ],
    'in-person': [
      { id: 'r4', days: [1, 2, 3, 4], start: '11:00', end: '13:00' }
    ]
  };
}

export default async function handler(req, res) {
  try {
    const data = (await kv.get('app-data')) || {};
    const today = new Date(); today.setHours(0,0,0,0);
    const todayStr = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0') + '-' + String(today.getDate()).padStart(2,'0');
    // Lightweight, no client PII — just enough for the booking page to compute what's still free.
    // Cancelled bookings are excluded entirely so they never block a time slot.
    const futureBookings = (data.bookings || [])
      .filter(b => b.date >= todayStr && !b.cancelled)
      .map(b => ({ date: b.date, time: b.time, durationMin: b.durationMin, type: b.type }));
    // Availability rules and one-off dates carry BOTH a general area ("Boro Park", meant to be
    // shown before booking) and the full street address with entry instructions (meant to be sent
    // only after booking). Strip the private half here — this endpoint is unauthenticated, so
    // anything returned is readable by anyone who opens the booking page. The real address is
    // resolved server-side at booking time and returned only to the person who booked.
    const publicRule = r => ({
      id: r.id, days: r.days, start: r.start, end: r.end,
      duration: r.duration, durations: r.durations,
      generalArea: r.generalArea || ''
    });
    const publicOverride = o => ({
      id: o.id, date: o.date, start: o.start, end: o.end, type: o.type,
      duration: o.duration, durations: o.durations,
      generalArea: o.generalArea || ''
    });

    const futureOverrides = (data.overrides || []).filter(o => o.date >= todayStr).map(publicOverride);
    const futureBlockedDates = (data.blockedDates || []).filter(bl => bl.date >= todayStr);
    const rawAvailability = data.availability || defaultAvailability();
    const publicAvailability = {
      virtual: (rawAvailability.virtual || []).map(publicRule),
      'in-person': (rawAvailability['in-person'] || []).map(publicRule)
    };
    res.status(200).json({
      bookings: futureBookings,
      overrides: futureOverrides,
      blockedDates: futureBlockedDates,
      settings: {
        // meetLink and location are deliberately NOT sent: the Meet link is reusable and the
        // location is a private address. Each booking gets its own Meet link at booking time.
        intakeQuestions: data.settings?.intakeQuestions || [],
        durationOptions: (data.settings?.durationOptions && data.settings.durationOptions.length) ? data.settings.durationOptions : [60],
        minLeadHours: (data.settings?.minLeadHours != null) ? data.settings.minLeadHours : 12,
        billingMode: data.settings?.billingMode || 'actual',
        hourlyRate: (data.settings?.hourlyRate != null) ? data.settings.hourlyRate : 500
      },
      availability: publicAvailability
    });
  } catch (err) {
    console.error('Server error:', err);
    await logError('public-state', err, { method: req.method, action: req.body?.action || req.query?.action });
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
