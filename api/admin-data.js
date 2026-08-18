import { kv } from '@vercel/kv';
import { put } from '@vercel/blob';
import { verifyAdminToken, randomToken } from './_lib/auth.js';
import { sendEmail, reminderEmail, dailyDigestEmail } from './_lib/email.js';

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
  const { bookingId, chunkIndex, chunkBase64, mimeType } = req.body || {};
  if (!bookingId || chunkIndex == null || !chunkBase64) return res.status(400).json({ error: 'Missing bookingId, chunkIndex, or chunkBase64.' });
  try {
    const format = mimeType || 'audio/webm';
    const ext = format.includes('mp4') ? 'mp4' : format.includes('ogg') ? 'ogg' : 'webm';
    const buffer = Buffer.from(chunkBase64, 'base64');
    const blob = await put(`recordings/${bookingId}/chunk-${String(chunkIndex).padStart(5, '0')}.${ext}`, buffer, {
      access: 'public',
      contentType: format
    });
    const key = 'recording-chunks:' + bookingId;
    const existing = (await kv.get(key)) || [];
    existing.push({ index: chunkIndex, url: blob.url, mimeType: format, ext });
    await kv.set(key, existing);
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Chunk upload failed: ' + e.message });
  }
}

async function handleFinalizeRecording(req, res) {
  const { bookingId, segmentStart, segmentEnd } = req.body || {};
  if (!bookingId) return res.status(400).json({ error: 'Missing bookingId.' });

  const data = await kv.get('app-data');
  if (!data) return res.status(404).json({ error: 'No data found' });
  const booking = (data.bookings || []).find(b => b.id === bookingId);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  const key = 'recording-chunks:' + bookingId;
  const chunks = (await kv.get(key)) || [];
  if (chunks.length === 0) return res.status(400).json({ error: 'No recording found for this session.' });
  chunks.sort((a, b) => a.index - b.index);
  const format = chunks[0].mimeType || 'audio/webm';
  const ext = chunks[0].ext || 'webm';

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
    form.append('file', new Blob([fullAudio], { type: format }), 'recording.' + ext);
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

    // Log this segment's precise start/stop time regardless of whether speech was detected,
    // so the timing log stays accurate even for a silent test.
    if (!Array.isArray(booking.recordingSegments)) booking.recordingSegments = [];
    const segStart = segmentStart || new Date().toISOString();
    const segEnd = segmentEnd || new Date().toISOString();
    const segMinutes = Math.max(1, Math.round((new Date(segEnd) - new Date(segStart)) / 60000));
    booking.recordingSegments.push({ start: segStart, end: segEnd, minutes: segMinutes });
    // Recording segments and the real Google Meet duration (from a separate "Fetch call
    // duration" check) are two independent sources of truth — never let a new segment shrink an
    // already-confirmed number, only ever increase it.
    const segmentsSum = booking.recordingSegments.reduce((sum, s) => sum + s.minutes, 0);
    booking.actualMinutes = Math.max(booking.actualMinutes || 0, segmentsSum);

    if (!transcript) {
      await kv.set('app-data', data);
      await kv.del(key);
      return res.status(200).json({ ok: true, summary: booking.summary || '', note: 'No speech was detected in this segment, but the time was still logged.' });
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
    const segmentSummary = gptData.choices?.[0]?.message?.content || '';

    const partNumber = booking.recordingSegments.length;
    const fmtClock = iso => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
    const partHeader = `Part ${partNumber} (${fmtClock(segStart)}\u2013${fmtClock(segEnd)}, ${segMinutes} min)`;
    const existingSummary = (booking.summary || '').trim();
    booking.summary = existingSummary
      ? `${existingSummary}\n\n---\n\n${partHeader}\n${segmentSummary}`
      : `${partHeader}\n${segmentSummary}`;

    const clientVersion = await generateClientFacingSummary(booking.summary);
    if (clientVersion) booking.clientSummary = clientVersion;

    await kv.set('app-data', data);
    await kv.del(key);
    res.status(200).json({ ok: true, summary: booking.summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function dateStrOf(d) { return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); }

// Generates a short, warm, client-appropriate version of the notes — separate wording from the
// internal notes, since internal notes may include things not meant for a client to read verbatim.
async function generateClientFacingSummary(internalNotes) {
  if (!process.env.OPENAI_API_KEY || !internalNotes) return '';
  try {
    const gptRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You write a short, warm summary of a coaching/consulting session for the CLIENT to read themselves in their portal. 2-4 sentences, plain language, no headers or bullet points, no internal admin details (billing, scheduling notes, "Part 1/Part 2" labels, anything not meant for the client). Just a friendly recap of what was covered.' },
          { role: 'user', content: internalNotes }
        ],
        temperature: 0.4
      })
    });
    if (!gptRes.ok) return '';
    const gptData = await gptRes.json();
    return gptData.choices?.[0]?.message?.content || '';
  } catch (e) {
    return '';
  }
}

// Runs once a day via Vercel Cron: emails Heshy a summary of today + tomorrow, and sends each
// client with a session tomorrow a reminder (tracked via booking.reminderSent so it only goes
// out once, even though this job runs every day).
async function handleDailyDigestAndReminders(req, res) {
  const data = await kv.get('app-data');
  if (!data) return res.status(200).json({ ok: true, note: 'No data yet.' });

  const now = new Date();
  const todayDs = dateStrOf(now);
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowDs = dateStrOf(tomorrow);

  const active = (data.bookings || []).filter(b => !b.cancelled);
  const todayBookings = active.filter(b => b.date === todayDs).sort((a,b) => a.time.localeCompare(b.time));
  const tomorrowBookings = active.filter(b => b.date === tomorrowDs).sort((a,b) => a.time.localeCompare(b.time));

  try {
    const digest = dailyDigestEmail(todayBookings, tomorrowBookings);
    await sendEmail({ to: 'heshy@catalystconsultingnyc.com', subject: digest.subject, html: digest.html });
  } catch (e) { /* best-effort */ }

  let remindersSent = 0;
  for (const booking of tomorrowBookings) {
    if (booking.reminderSent) continue;
    try {
      const reminder = reminderEmail(booking, data.settings || {});
      await sendEmail({ to: booking.clientEmail, subject: reminder.subject, html: reminder.html });
      booking.reminderSent = true;
      remindersSent++;
    } catch (e) { /* best-effort, try again tomorrow's run won't help since booking will have passed — log and move on */ }
  }
  if (remindersSent > 0) await kv.set('app-data', data);

  res.status(200).json({ ok: true, digestSentFor: { today: todayBookings.length, tomorrow: tomorrowBookings.length }, remindersSent });
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

  // Mark as cancelled via a separate flag rather than overwriting status — this preserves
  // whatever billing state it already had (e.g. 'charged'), so a session you had to cancel
  // after charging never loses that record. The Calendar event deletion above is what actually
  // frees the time; excluding cancelled bookings from availability checks (elsewhere) frees the
  // app's own slot too.
  booking.cancelled = true;
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
    // Vercel Cron hits this on a schedule with a bearer token it generates from CRON_SECRET —
    // it can't send our normal admin session token, so this gets its own check, checked first.
    if (req.headers['authorization'] === `Bearer ${process.env.CRON_SECRET}` && process.env.CRON_SECRET) {
      return handleDailyDigestAndReminders(req, res);
    }

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
