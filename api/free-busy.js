import { kv } from '@vercel/kv';
import { limited } from './_lib/limits.js';
import { logError } from './_lib/errorlog.js';

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
    if (await limited(req, res, 'free-busy', 60, 3600)) return;
    const timeMin = req.query.timeMin;
    const timeMax = req.query.timeMax;
    // Bound the queryable window: this endpoint is public (the booking page needs it), but
    // without limits anyone could mine the owner's personal calendar patterns for any date
    // range in history or years ahead. Only allow what the booking page legitimately needs:
    // from yesterday to 180 days out.
    const min = new Date(timeMin), max = new Date(timeMax);
    const now = Date.now();
    if (isNaN(min) || isNaN(max) || max <= min
        || min.getTime() < now - 24*60*60*1000
        || max.getTime() > now + 180*24*60*60*1000) {
      return res.status(400).json({ error: 'Invalid time range.' });
    }
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
    console.error('Server error:', err);
    await logError('free-busy', err, { method: req.method, action: req.body?.action || req.query?.action });
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
