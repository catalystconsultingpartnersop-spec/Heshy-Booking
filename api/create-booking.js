import { kv } from '@vercel/kv';
import { sendEmail, bookingConfirmationEmail, newBookingAlertEmail } from './_lib/email.js';

async function getGoogleAccessToken() {
  const refreshToken = await kv.get('google-refresh-token');
  if (!refreshToken) return null;
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  });
  const d = await r.json();
  return d.access_token || null;
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { slotId, name, email, phone, intakeAnswers, wgPdfName, wgPdfData, stripeCustomerId } = req.body || {};
    if (!slotId || !name || !email || !phone || !stripeCustomerId) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }

    const data = await kv.get('app-data');
    if (!data) return res.status(400).json({ error: 'No data found.' });
    if (!data.clients) data.clients = [];
    if (!data.bookings) data.bookings = [];

    const slot = (data.slots || []).find(s => s.id === slotId);
    if (!slot) return res.status(400).json({ error: 'That time is no longer available.' });
    if (data.bookings.some(b => b.slotId === slotId)) {
      return res.status(400).json({ error: 'That time was just booked by someone else.' });
    }

    let client = data.clients.find(c => c.email.toLowerCase() === email.toLowerCase());
    if (client && client.blocked) {
      return res.status(403).json({ error: 'Unable to book at this time.' });
    }
    if (!client) {
      client = {
        id: uid(), name, email, phone,
        intakeAnswers: intakeAnswers || [], wgPdfName: wgPdfName || '', wgPdfData: wgPdfData || '',
        blocked: false, createdAt: Date.now()
      };
      data.clients.push(client);
    }

    const booking = {
      id: uid(), slotId: slot.id, date: slot.date, time: slot.time,
      durationMin: slot.duration, type: slot.type,
      clientId: client.id, clientName: name, clientEmail: email, clientPhone: phone,
      stripeCustomerId, status: 'scheduled',
      meetLink: '', summary: '', clientSummary: '', actualMinutes: null, amount: null, createdAt: Date.now()
    };
    data.bookings.push(booking);

    try {
      const accessToken = await getGoogleAccessToken();
      if (accessToken) {
        const startISO = new Date(slot.date + 'T' + slot.time + ':00').toISOString();
        const endISO = new Date(new Date(startISO).getTime() + slot.duration * 60000).toISOString();
        const evRes = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({
            summary: 'Clarity session — ' + name,
            location: slot.type === 'in-person' ? (data.settings?.location || '') : '',
            start: { dateTime: startISO },
            end: { dateTime: endISO },
            conferenceData: {
              createRequest: {
                requestId: booking.id,
                conferenceSolutionKey: { type: 'hangoutsMeet' }
              }
            }
          })
        });
        const evData = await evRes.json();
        if (evData.hangoutLink) {
          booking.meetLink = evData.hangoutLink;
        }
      }
    } catch (e) { /* calendar sync is best-effort */ }

    await kv.set('app-data', data);

    try {
      const confirmation = bookingConfirmationEmail(booking, data.settings || {});
      await sendEmail({ to: booking.clientEmail, subject: confirmation.subject, html: confirmation.html });
      const alert = newBookingAlertEmail(booking);
      await sendEmail({ to: 'heshy@catalystconsultingnyc.com', subject: alert.subject, html: alert.html });
    } catch (e) { /* email is best-effort */ }

    res.status(200).json({ ok: true, bookingId: booking.id, meetLink: slot.type === 'virtual' ? booking.meetLink : undefined });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
