import { kv } from '@vercel/kv';
import { put } from '@vercel/blob';
import { verifyAdminToken, randomToken } from './_lib/auth.js';

export const maxDuration = 60;

function defaultState() {
  return {
    bookings: [],
    clients: [],
    overrides: [],
    settings: { meetLink: '', location: '', durationOptions: [60], intakeQuestions: [] },
    availability: { virtual: [], 'in-person': [] }
  };
}

function dowOf(dateStr) { const [y, mo, d] = dateStr.split('-').map(Number); return new Date(Date.UTC(y, mo - 1, d)).getUTCDay(); }

// Resolves which address applies for a given date, for in-person only — matches the same logic
// used at original booking time in create-booking.js, so a reschedule to a different day (or a
// different format) correctly picks up that day's own location.
function resolveAddress(data, date) {
  const override = (data.overrides || []).find(o => o.date === date && o.type === 'in-person' && o.address);
  if (override) return override.address;
  const weekday = dowOf(date);
  const rule = (data.availability?.['in-person'] || []).find(r => r.days.includes(weekday) && r.address);
  if (rule) return rule.address;
  return data.settings?.location || '';
}

// Compute date/time after adding minutes, using UTC arithmetic purely as scratch
// math (never converted to a real timezone) so it's deterministic regardless of
// what timezone the server process happens to run in.
function addMinutes(dateStr, timeStr, minutesToAdd) {
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
const APP_TIMEZONE = 'America/New_York';

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

async function handleUploadRecordingChunk(req, res) {
  const { bookingId, chunkIndex, chunkBase64 } = req.body || {};
  if (!bookingId || chunkIndex == null || !chunkBase64) return res.status(400).json({ error: 'Missing bookingId, chunkIndex, or chunkBase64.' });
  try {
    const buffer = Buffer.from(chunkBase64, 'base64');
    const blob = await put(`recordings/${bookingId}/chunk-${String(chunkIndex).padStart(5, '0')}.webm`, buffer, {
      access: 'public',
      contentType: 'audio/webm'
    });
    const key = 'recording-chunks:' + bookingId;
    const existing = (await kv.get(key)) || [];
    existing.push({ index: chunkIndex, url: blob.url });
    await kv.set(key, existing);
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Chunk upload failed: ' + e.message });
  }
}

async function handleFinalizeRecording(req, res) {
  const { bookingId } = req.body || {};
  if (!bookingId) return res.status(400).json({ error: 'Missing bookingId.' });

  const data = await kv.get('app-data');
  if (!data) return res.status(404).json({ error: 'No data found' });
  const booking = (data.bookings || []).find(b => b.id === bookingId);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  const key = 'recording-chunks:' + bookingId;
  const chunks = (await kv.get(key)) || [];
  if (chunks.length === 0) return res.status(400).json({ error: 'No recording found for this session.' });
  chunks.sort((a, b) => a.index - b.index);

  try {
    // Download and stitch every chunk back into one file, in the order they were recorded.
    const buffers = [];
    for (const c of chunks) {
      const r = await fetch(c.url);
      if (!r.ok) continue;
      buffers.push(Buffer.from(await r.arrayBuffer()));
    }
    const fullAudio = Buffer.concat(buffers);

    const form = new FormData();
    form.append('file', new Blob([fullAudio], { type: 'audio/webm' }), 'recording.webm');
    form.append('model', 'whisper-1');
    const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form
    });
    if (!whisperRes.ok) {
      const errText = await whisperRes.text().catch(() => '');
      return res.status(500).json({ error: 'Transcription failed: ' + errText.slice(0, 300) });
    }
    const whisperData = await whisperRes.json();
    const transcript = (whisperData.text || '').trim();
    if (!transcript) {
      await kv.delete(key);
      return res.status(200).json({ ok: true, summary: '', note: 'No speech was detected in the recording.' });
    }

    const systemPrompt = `You write short, plain, clear session notes for a consultant named Heshy. The transcript may mix English and Yiddish — understand all of it, but write the notes in English. Always structure your response in exactly three short sections with these exact headers, each with 1-4 brief bullet points. No long paragraphs, no flowery language, no fluff.

What we discussed
Key points
Next steps

If a section has nothing to report, write "None." under it. Stay factual and concise.`;
    const gptRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: transcript }
        ],
        temperature: 0.3
      })
    });
    if (!gptRes.ok) {
      const errText = await gptRes.text().catch(() => '');
      return res.status(500).json({ error: 'Summary failed: ' + errText.slice(0, 300) });
    }
    const gptData = await gptRes.json();
    const summary = gptData.choices?.[0]?.message?.content || '';

    booking.summary = summary;
    await kv.set('app-data', data);
    await kv.delete(key);
    res.status(200).json({ ok: true, summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function handleCleanupLargePdfs(req, res) {
  const data = await kv.get('app-data');
  if (!data) return res.status(404).json({ error: 'No data found' });
  const target = (data.clients || []).find(c => c.wgPdfData && c.wgPdfData.startsWith('data:'));
  if (!target) return res.status(200).json({ ok: true, migrated: null, remaining: 0 });
  let status;
  try {
    const base64 = target.wgPdfData.split(',')[1];
    const buffer = Buffer.from(base64, 'base64');
    const safeName = (target.wgPdfName || 'working-genius.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
    const blob = await put('wg-pdfs/' + Date.now() + '-' + safeName, buffer, { access: 'public', contentType: 'application/pdf' });
    target.wgPdfData = blob.url;
    status = 'migrated to Blob storage';
  } catch (e) {
    target.wgPdfData = '';
    status = 'could not migrate, PDF removed (re-upload manually): ' + e.message;
  }
  await kv.set('app-data', data);
  const remaining = (data.clients || []).filter(c => c.wgPdfData && c.wgPdfData.startsWith('data:')).length;
  res.status(200).json({ ok: true, migrated: { client: target.name, status }, remaining });
}

async function handleUploadPdf(req, res) {
  const { fileName, fileDataUrl } = req.body || {};
  if (!fileName || !fileDataUrl) return res.status(400).json({ error: 'Missing fileName or fileDataUrl.' });
  try {
    const base64 = fileDataUrl.split(',')[1];
    if (!base64) return res.status(400).json({ error: 'Invalid file data.' });
    const buffer = Buffer.from(base64, 'base64');
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const blob = await put('wg-pdfs/' + Date.now() + '-' + safeName, buffer, {
      access: 'public',
      contentType: 'application/pdf'
    });
    res.status(200).json({ ok: true, url: blob.url });
  } catch (e) {
    res.status(500).json({ error: 'Upload failed: ' + e.message });
  }
}

async function handleCancelBooking(req, res) {
  const { bookingId } = req.body || {};
  if (!bookingId) return res.status(400).json({ error: 'Missing bookingId.' });

  const data = await kv.get('app-data');
  if (!data) return res.status(404).json({ error: 'No data found' });

  const booking = (data.bookings || []).find(b => b.id === bookingId);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  // Delete the linked Google Calendar event so the time actually frees up —
  // otherwise Calendar still reports it busy even after the booking is gone.
  let calendarWarning = null;
  if (booking.calendarEventId) {
    try {
      const accessToken = await getGoogleAccessToken();
      if (accessToken) {
        const delRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${booking.calendarEventId}?sendUpdates=all`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        if (!delRes.ok && delRes.status !== 410 && delRes.status !== 404) {
          calendarWarning = `Booking cancelled, but the calendar event could not be removed (status ${delRes.status}). You may need to delete it manually from Google Calendar.`;
        }
      } else {
        calendarWarning = 'Booking cancelled, but Google Calendar is not connected — the old calendar event was not removed.';
      }
    } catch (e) {
      calendarWarning = 'Booking cancelled, but removing the calendar event failed: ' + e.message;
    }
  }

  data.bookings = data.bookings.filter(b => b.id !== bookingId);
  await kv.set('app-data', data);
  res.status(200).json({ ok: true, warning: calendarWarning });
}

async function handleRescheduleBooking(req, res) {
  const { bookingId, newDate, newTime, newType } = req.body || {};
  if (!bookingId) return res.status(400).json({ error: 'Missing bookingId.' });
  if (!newDate || !newTime) return res.status(400).json({ error: 'Provide newDate and newTime.' });

  const data = await kv.get('app-data');
  if (!data) return res.status(404).json({ error: 'No data found' });

  const booking = (data.bookings || []).find(b => b.id === bookingId);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  const targetDate = newDate, targetTime = newTime, targetDuration = booking.durationMin;
  const targetType = (newType === 'virtual' || newType === 'in-person') ? newType : booking.type;
  const targetLocation = targetType === 'in-person' ? resolveAddress(data, targetDate) : '';

  if (booking.calendarEventId) {
    try {
      const accessToken = await getGoogleAccessToken();
      if (accessToken) {
        const endAt = addMinutes(targetDate, targetTime, targetDuration);
        const patchBody = {
          start: { dateTime: targetDate + 'T' + targetTime + ':00', timeZone: APP_TIMEZONE },
          end: { dateTime: endAt.date + 'T' + endAt.time + ':00', timeZone: APP_TIMEZONE },
          location: targetLocation
        };
        await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${booking.calendarEventId}?sendUpdates=all`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify(patchBody)
        });
      }
    } catch (e) { /* calendar sync is best-effort, don't block the reschedule */ }
  }

  booking.date = targetDate;
  booking.time = targetTime;
  booking.durationMin = targetDuration;
  booking.type = targetType;
  booking.location = targetLocation;

  await kv.set('app-data', data);
  res.status(200).json({ ok: true });
}

export default async function handler(req, res) {
  try {
    if (req.method === 'POST' && req.body && req.body.action === 'login') {
      const { password } = req.body;
      if (!password || password !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Incorrect password' });
      }
      const token = randomToken();
      await kv.set('admin-session:' + token, true);
      return res.status(200).json({ ok: true, token });
    }

    if (!(await verifyAdminToken(req))) return res.status(401).json({ error: 'Unauthorized' });

    if (req.method === 'POST' && req.body && req.body.action === 'cancel-booking') {
      return handleCancelBooking(req, res);
    }
    if (req.method === 'POST' && req.body && req.body.action === 'reschedule-booking') {
      return handleRescheduleBooking(req, res);
    }
    if (req.method === 'POST' && req.body && req.body.action === 'upload-pdf') {
      return handleUploadPdf(req, res);
    }
    if (req.method === 'POST' && req.body && req.body.action === 'cleanup-large-pdfs') {
      return handleCleanupLargePdfs(req, res);
    }
    if (req.method === 'POST' && req.body && req.body.action === 'upload-recording-chunk') {
      return handleUploadRecordingChunk(req, res);
    }
    if (req.method === 'POST' && req.body && req.body.action === 'finalize-recording') {
      return handleFinalizeRecording(req, res);
    }

    if (req.method === 'GET') {
      const data = (await kv.get('app-data')) || defaultState();
      return res.status(200).json(data);
    }
    if (req.method === 'POST') {
      await kv.set('app-data', req.body);
      return res.status(200).json({ ok: true });
    }
    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
