import { kv } from '@vercel/kv';

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
    const futureBookings = (data.bookings || [])
      .filter(b => b.date >= todayStr)
      .map(b => ({ date: b.date, time: b.time, durationMin: b.durationMin, type: b.type }));
    const futureOverrides = (data.overrides || []).filter(o => o.date >= todayStr);
    res.status(200).json({
      bookings: futureBookings,
      overrides: futureOverrides,
      settings: {
        meetLink: data.settings?.meetLink || '',
        location: data.settings?.location || '',
        intakeQuestions: data.settings?.intakeQuestions || [],
        durationOptions: (data.settings?.durationOptions && data.settings.durationOptions.length) ? data.settings.durationOptions : [60]
      },
      availability: data.availability || defaultAvailability()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
