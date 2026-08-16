import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  try {
    const email = (req.query.email || '').toLowerCase();
    const data = await kv.get('app-data');
    const client = (data?.clients || []).find(c => c.email.toLowerCase() === email);
    if (!client) return res.status(200).json({ found: false });

    const bookings = (data.bookings || []).filter(b => b.clientId === client.id);
    const upcoming = bookings
      .filter(b => b.status !== 'charged')
      .map(b => ({ date: b.date, time: b.time, type: b.type }));
    const past = bookings
      .filter(b => b.status === 'charged')
      .map(b => ({
        date: b.date, actualMinutes: b.actualMinutes, durationMin: b.durationMin,
        type: b.type, amount: b.amount, clientSummary: b.clientSummary
      }));

    res.status(200).json({ found: true, name: client.name, phone: client.phone, upcoming, past });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
