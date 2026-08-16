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
  try {
    const timeMin = req.query.timeMin;
    const timeMax = req.query.timeMax;
    const accessToken = await getAccessToken();
    if (!accessToken) {
      return res.status(200).json({ connected: false, busy: [] });
    }
    const fbRes = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ timeMin, timeMax, items: [{ id: 'primary' }] })
    });
    const fbData = await fbRes.json();
    const busy = (fbData.calendars && fbData.calendars.primary && fbData.calendars.primary.busy) || [];
    res.status(200).json({ connected: true, busy });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
