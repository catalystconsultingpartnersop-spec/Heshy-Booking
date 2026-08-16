import { kv } from '@vercel/kv';

async function getAccessToken() {
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
  const data = await r.json();
  return data.access_token || null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { summary, description, startISO, endISO, location } = req.body;
    const accessToken = await getAccessToken();
    if (!accessToken) return res.status(200).json({ created: false });

    const event = {
      summary,
      description,
      start: { dateTime: startISO },
      end: { dateTime: endISO }
    };
    if (location) event.location = location;

    const r = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(event)
    });
    const data = await r.json();
    res.status(200).json({ created: true, eventId: data.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
