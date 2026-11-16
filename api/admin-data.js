import { kv } from '@vercel/kv';
import { storeFile, removeFile, rotateFile, isLegacyPath } from './_lib/files.js';
import { verifyAdminToken, verifyAgentKey, randomToken, issueScopedToken } from './_lib/auth.js';
import { sendEmail, reminderEmail, dailyDigestEmail, rescheduledEmail, strengthsInviteEmail, cancellationEmail } from './_lib/email.js';
import { checkSlot } from './_lib/availability.js';
import { logError, readErrors, clearErrors, logAgentAccess, readAgentLog } from './_lib/errorlog.js';
import { buildSummary, buildDetail } from './_lib/diagnostics.js';
import { mutate, SKIP_WRITE, readData } from './_lib/store.js';
import { takeBackup, listBackups, readBackup, isDueForBackup } from './_lib/backup.js';
import { validateAppData } from './_lib/schema.js';
import { stripe } from './_lib/stripecustomer.js';
import { EVENTS as STRIPE_EVENTS } from './_lib/stripeevents.js';
import { callerIp, checkDataUrl, MAX_PDF_BYTES, MAX_AUDIO_BYTES } from './_lib/limits.js';

const ADMIN_SESSION_SECONDS = 60 * 60 * 12; // 12 hours

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
    if (chunkBase64.length > MAX_AUDIO_BYTES * 1.4) return res.status(400).json({ error: 'That audio chunk is too large.' });
    const buffer = Buffer.from(chunkBase64, 'base64');
    // Was recordings/<bookingId>/chunk-00001.webm — derivable by anyone who knew a booking id.
    // The path is the only thing protecting a recording of a private session, so it is random.
    const url = await storeFile('recordings', `chunk-${String(chunkIndex).padStart(5, '0')}.${ext}`, buffer, format);
    const key = 'recording-chunks:' + bookingId;
    const existing = (await kv.get(key)) || [];
    existing.push({ index: chunkIndex, url, mimeType: format, ext });
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
      await mutate(fresh => {
        const b = (fresh.bookings || []).find(x => x.id === booking.id);
        if (!b) return SKIP_WRITE;
        b.recordingSegments = booking.recordingSegments;
        b.actualMinutes = booking.actualMinutes;
      });
      // The manifest was cleared here but the audio itself was left in storage forever. Private
      // recordings of client sessions should not outlive the transcript they produced.
      for (const c of chunks) await removeFile(c.url);
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

    await mutate(fresh => {
      const b = (fresh.bookings || []).find(x => x.id === booking.id);
      if (!b) return SKIP_WRITE;
      b.recordingSegments = booking.recordingSegments;
      b.actualMinutes = booking.actualMinutes;
      b.summary = booking.summary;
      if (clientVersion) b.clientSummary = booking.clientSummary;
    });
    // Transcribed and summarised — the audio has done its job and is deleted.
    for (const c of chunks) await removeFile(c.url);
    await kv.del(key);
    res.status(200).json({ ok: true, summary: booking.summary });
  } catch (err) {
    console.error('Server error:', err);
    await logError('admin-data', err, { method: req.method, action: req.body?.action || req.query?.action });
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
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

  // Snapshot the record once a day, on the back of the run that is already happening. Failing
  // to back up never stops the reminders going out.
  if (await isDueForBackup(20)) await takeBackup(data, 'daily');

  // Keep moving any files still on the old guessable paths. A few per night finishes quickly
  // and never risks timing out the run that sends the reminders.
  try { await handleSecureFiles({ query: {}, body: {} }, { status: () => ({ json: () => {} }) }); }
  catch (e) { console.error('File securing pass failed:', e); }

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
  const reminderFailures = [];
  for (const booking of tomorrowBookings) {
    if (booking.reminderSent) continue;
    if (!booking.clientEmail) continue;
    try {
      const reminder = reminderEmail(booking, data.settings || {});
      // Only record it as sent if it actually sent. sendEmail used to swallow failures and
      // return normally, so a reminder that never left Resend was still marked done — and
      // then never retried.
      const ok = await sendEmail({ to: booking.clientEmail, subject: reminder.subject, html: reminder.html });
      if (ok) {
        booking.reminderSent = true;
        booking.reminderSentAt = new Date().toISOString();
        remindersSent++;
      } else {
        reminderFailures.push({ bookingId: booking.id, client: booking.clientName });
      }
    } catch (e) {
      console.error('Reminder failed for', booking.id, e);
      reminderFailures.push({ bookingId: booking.id, client: booking.clientName });
    }
  }
  if (remindersSent > 0) {
    const sentIds = (data.bookings || []).filter(b => b.reminderSent && b.reminderSentAt).map(b => ({ id: b.id, at: b.reminderSentAt }));
    await mutate(fresh => {
      let touched = 0;
      for (const { id, at } of sentIds) {
        const b = (fresh.bookings || []).find(x => x.id === id);
        if (b && !b.reminderSent) { b.reminderSent = true; b.reminderSentAt = at; touched++; }
      }
      if (!touched) return SKIP_WRITE;
    });
  }

  if (reminderFailures.length) {
    console.error('Reminders that did not send:', JSON.stringify(reminderFailures));
    try {
      await sendEmail({
        to: 'heshy@catalystconsultingnyc.com',
        subject: `Heads up: ${reminderFailures.length} reminder${reminderFailures.length === 1 ? '' : 's'} did not send`,
        html: `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;">
          These clients have a session tomorrow and did <strong>not</strong> get their reminder:
          <ul>${reminderFailures.map(f => `<li>${f.client || f.bookingId}</li>`).join('')}</ul>
          The app will try again on the next run. You may want to message them directly.
        </div>`
      });
    } catch (e) { /* if even this can't send, the console log above is the record */ }
  }

  res.status(200).json({
    ok: true,
    digestSentFor: { today: todayBookings.length, tomorrow: tomorrowBookings.length },
    remindersSent,
    reminderFailures: reminderFailures.length
  });
}

/**
 * Moves files that are still on the old, guessable paths onto unguessable ones and deletes the
 * originals, so any link that leaked stops working. Runs a few at a time so a single request
 * can't time out; the daily job keeps calling it until there is nothing left.
 */
async function handleSecureFiles(req, res) {
  const data = await readData();
  if (!data) return res.status(404).json({ error: 'No data found' });

  const todo = [];
  for (const c of (data.clients || [])) {
    if (c.wgPdfData && isLegacyPath(c.wgPdfData)) todo.push({ kind: 'client', id: c.id, url: c.wgPdfData, name: c.wgPdfName || 'report.pdf' });
  }
  for (const b of (data.bookings || [])) {
    for (const seg of (b.recordingSegments || [])) {
      if (seg.url && isLegacyPath(seg.url)) todo.push({ kind: 'segment', id: b.id, segUrl: seg.url, url: seg.url, name: 'segment.webm' });
    }
  }

  const batch = todo.slice(0, 5);
  let moved = 0, failed = 0;
  for (const item of batch) {
    const next = await rotateFile(item.kind === 'client' ? 'wg-pdfs' : 'recordings', item.name, item.url);
    if (!next) { failed++; continue; }
    await mutate(fresh => {
      if (item.kind === 'client') {
        const c = (fresh.clients || []).find(x => x.id === item.id);
        if (!c || c.wgPdfData !== item.url) return SKIP_WRITE;
        c.wgPdfData = next;
      } else {
        const b = (fresh.bookings || []).find(x => x.id === item.id);
        const seg = (b?.recordingSegments || []).find(x => x.url === item.segUrl);
        if (!seg) return SKIP_WRITE;
        seg.url = next;
      }
    });
    moved++;
  }
  return res.status(200).json({ ok: true, moved, failed, remaining: Math.max(0, todo.length - moved) });
}

async function handleCleanupLargePdfs(req, res) {
  const data = await kv.get('app-data');
  if (!data) return res.status(404).json({ error: 'No data found' });
  const target = (data.clients || []).find(c => c.wgPdfData && c.wgPdfData.startsWith('data:'));
  if (!target) return res.status(200).json({ ok: true, migrated: null, remaining: 0 });
  let status;
  let migrated = false;
  try {
    const base64 = target.wgPdfData.split(',')[1];
    const buffer = Buffer.from(base64, 'base64');
    const safeName = (target.wgPdfName || 'working-genius.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
    const url = await storeFile('wg-pdfs', safeName, buffer, 'application/pdf');
    if (!url) throw new Error('Storage did not return a url for the uploaded file.');
    target.wgPdfData = url;
    migrated = true;
    status = 'migrated to Blob storage';
  } catch (e) {
    // This used to clear the original and save anyway, so a momentary storage failure
    // permanently destroyed the only copy of a client's report. The original is now kept
    // exactly as it was and the move simply reported as not done.
    status = 'could not move it this time, so the original has been left untouched: ' + e.message;
  }
  if (!migrated) {
    const remainingNow = (data.clients || []).filter(c => c.wgPdfData && c.wgPdfData.startsWith('data:')).length;
    return res.status(200).json({ ok: false, migrated: { client: target.name, status }, remaining: remainingNow });
  }
  await mutate(fresh => {
    const c = (fresh.clients || []).find(x => x.id === target.id);
    if (!c) return SKIP_WRITE;
    c.wgPdfData = target.wgPdfData;
  });
  const remaining = (data.clients || []).filter(c => c.wgPdfData && c.wgPdfData.startsWith('data:')).length;
  res.status(200).json({ ok: true, migrated: { client: target.name, status }, remaining });
}

async function handleUploadPdf(req, res) {
  const { fileName, fileDataUrl } = req.body || {};
  if (!fileName || !fileDataUrl) return res.status(400).json({ error: 'Missing fileName or fileDataUrl.' });
  // The declared type used to be taken at face value, and nothing bounded the size before it
  // was decoded into memory.
  const badFile = checkDataUrl(fileDataUrl, { expect: 'pdf', maxBytes: MAX_PDF_BYTES });
  if (badFile) return res.status(400).json({ error: badFile });
  try {
    const base64 = fileDataUrl.split(',')[1];
    if (!base64) return res.status(400).json({ error: 'Invalid file data.' });
    const buffer = Buffer.from(base64, 'base64');
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const url = await storeFile('wg-pdfs', safeName, buffer, 'application/pdf');
    res.status(200).json({ ok: true, url });
  } catch (e) {
    res.status(500).json({ error: 'Upload failed: ' + e.message });
  }
}

async function handleCancelBooking(req, res) {
  const { bookingId, reason } = req.body || {};
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
  await mutate(fresh => {
    const b = (fresh.bookings || []).find(x => x.id === booking.id);
    if (!b) return SKIP_WRITE;
    b.cancelled = true;
    b.cancelledAt = Date.now();
    b.cancelledBy = 'heshy';
    if (String(reason || '').trim()) b.cancellationReason = String(reason).trim().slice(0, 1000);
  });

  // Tell the client. Nothing used to be sent at all: whatever they heard came from Google
  // Calendar's own notice, or nothing.
  let emailWarning = null;
  if (booking.clientEmail) {
    try {
      const mail = cancellationEmail(booking, data.settings || {}, { by: 'heshy', reason });
      const sent = await sendEmail({ to: booking.clientEmail, subject: mail.subject, html: mail.html });
      if (!sent) emailWarning = "The session is cancelled, but the email to the client didn't send. Let them know yourself.";
    } catch (e) {
      emailWarning = "The session is cancelled, but the email to the client didn't send. Let them know yourself.";
    }
  } else {
    emailWarning = 'The session is cancelled. There was no email address on file, so nothing was sent.';
  }
  if (emailWarning) await logError('cancel-booking', new Error(emailWarning), { bookingId });

  res.status(200).json({ ok: true, warning: [calendarWarning, emailWarning].filter(Boolean).join(' ') || null });
}

async function handleRescheduleBooking(req, res) {
  const { bookingId, newDate, newTime, newType } = req.body || {};
  if (!bookingId) return res.status(400).json({ error: 'Missing bookingId.' });
  if (!newDate || !newTime) return res.status(400).json({ error: 'Provide newDate and newTime.' });

  const data = await kv.get('app-data');
  if (!data) return res.status(404).json({ error: 'No data found' });

  const booking = (data.bookings || []).find(b => b.id === bookingId);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  if (booking.cancelled) return res.status(400).json({ error: 'That session is cancelled. Un-cancel it first, or book a new one.' });

  const targetDate = newDate, targetTime = newTime, targetDuration = booking.durationMin;
  const targetType = (newType === 'virtual' || newType === 'in-person') ? newType : booking.type;

  // Moving a session used to accept anything: a date in the past, a time outside open hours,
  // or a slot where another session already sits. Run the same check a client booking runs,
  // ignoring this booking's own slot, and without the client notice period (an admin moving
  // something to tomorrow morning is legitimate).
  const verdict = checkSlot(data, {
    date: targetDate, time: targetTime, durationMin: targetDuration, type: targetType,
    excludeBookingId: booking.id, requireLeadTime: false
  });
  if (!verdict.ok) return res.status(400).json({ error: verdict.reason });

  const previous = { date: booking.date, time: booking.time, type: booking.type };
  const targetLocation = targetType === 'in-person' ? resolveAddress(data, targetDate) : '';

  // Keep Google Calendar in step, and report honestly when we can't.
  let calendarWarning = null;
  let newCalendarEventId = booking.calendarEventId || null;
  let newMeetLink = booking.meetLink || '';
  try {
    const accessToken = await getGoogleAccessToken();
    if (!accessToken) {
      calendarWarning = 'Session moved, but Google Calendar is not connected — your calendar still shows the old time.';
    } else {
      const endAt = addMinutes(targetDate, targetTime, targetDuration);
      const start = { dateTime: targetDate + 'T' + targetTime + ':00', timeZone: APP_TIMEZONE };
      const end = { dateTime: endAt.date + 'T' + endAt.time + ':00', timeZone: APP_TIMEZONE };

      let patched = false;
      if (booking.calendarEventId) {
        const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${booking.calendarEventId}?sendUpdates=all`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ start, end, location: targetLocation })
        });
        patched = r.ok;
        if (!r.ok && r.status !== 404 && r.status !== 410) {
          const body = await r.text().catch(() => '');
          console.error('Calendar patch failed:', r.status, body.slice(0, 300));
          calendarWarning = 'Session moved, but updating the Google Calendar event failed — please check your calendar.';
        }
      }

      // No event id, or the event was deleted straight out of Google Calendar (404/410).
      // Previously the failed patch was swallowed and nothing was created, so the session
      // simply vanished from the calendar while the app still showed it.
      if (!patched) {
        const evRes = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({
            summary: 'Clarity session — ' + (booking.clientName || ''),
            location: targetLocation,
            start, end,
            attendees: booking.clientEmail ? [{ email: booking.clientEmail }] : [],
            conferenceData: { createRequest: { requestId: booking.id + '-' + Date.now(), conferenceSolutionKey: { type: 'hangoutsMeet' } } }
          })
        });
        if (evRes.ok) {
          const ev = await evRes.json();
          if (ev.id) newCalendarEventId = ev.id;
          if (ev.hangoutLink) newMeetLink = ev.hangoutLink;
          calendarWarning = booking.calendarEventId
            ? 'The old calendar event was gone, so a new one was created at the new time.'
            : calendarWarning;
        } else {
          const body = await evRes.text().catch(() => '');
          console.error('Calendar create-on-reschedule failed:', evRes.status, body.slice(0, 300));
          calendarWarning = 'Session moved, but it could not be added to your Google Calendar — please add it manually.';
        }
      }
    }
  } catch (e) {
    console.error('Calendar sync on reschedule failed:', e);
    calendarWarning = 'Session moved, but syncing Google Calendar failed — please check your calendar.';
  }

  booking.date = targetDate;
  booking.time = targetTime;
  booking.durationMin = targetDuration;
  booking.type = targetType;
  booking.location = targetLocation;
  booking.calendarEventId = newCalendarEventId;
  booking.meetLink = newMeetLink;
  // The old reminder no longer describes this session, so let the daily job send a fresh one.
  delete booking.reminderSentAt;
  delete booking.reminderSent;

  await mutate(fresh => {
    const b = (fresh.bookings || []).find(x => x.id === booking.id);
    if (!b) return SKIP_WRITE;
    Object.assign(b, {
      date: booking.date, time: booking.time, durationMin: booking.durationMin,
      type: booking.type, location: booking.location,
      calendarEventId: booking.calendarEventId, meetLink: booking.meetLink
    });
    delete b.reminderSentAt;
    delete b.reminderSent;
  });

  // Tell the client. Previously nothing was sent at all, so a moved session was only
  // communicated if Heshy happened to email them himself.
  let emailWarning = null;
  if (booking.clientEmail) {
    try {
      const mail = rescheduledEmail(booking, previous, data.settings || {});
      const sent = await sendEmail({ to: booking.clientEmail, subject: mail.subject, html: mail.html });
      if (!sent) emailWarning = 'Session moved, but the email to the client did not send.';
    } catch (e) {
      console.error('Reschedule email failed:', e);
      emailWarning = 'Session moved, but the email to the client did not send.';
    }
  }

  const warning = [calendarWarning, emailWarning].filter(Boolean).join(' ');
  res.status(200).json({ ok: true, warning: warning || undefined });
}

export default async function handler(req, res) {
  let validationError = null;
  try {
    // Vercel Cron hits this on a schedule with a bearer token it generates from CRON_SECRET —
    // it can't send our normal admin session token, so this gets its own check, checked first.
    if (req.headers['authorization'] === `Bearer ${process.env.CRON_SECRET}` && process.env.CRON_SECRET) {
      return handleDailyDigestAndReminders(req, res);
    }

    // --- Read-only agent access -------------------------------------------------------------
    // A separate credential (AGENT_READ_KEY) that lets Claude inspect the app's state without
    // Heshy's password. It is handled FIRST — before login, before logout, before the admin gate
    // — and returns from inside this block in every case. So a request carrying this header can
    // never fall through into any other action: not a write, and not the login path that mints an
    // admin session token. It answers exactly three read-only questions and nothing else.
    if (req.headers['x-agent-key']) {
      if (!verifyAgentKey(req)) {
        await logAgentAccess('rejected', { reason: 'bad key' });
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const what = req.query?.view || 'summary';
      const data = (await kv.get('app-data')) || defaultState();

      if (what === 'summary') {
        await logAgentAccess('summary', {});
        return res.status(200).json(buildSummary(data));
      }
      if (what === 'problems') {
        await logAgentAccess('problems', {});
        return res.status(200).json({ entries: await readErrors(60) });
      }
      if (what === 'detail') {
        const { bookingId, clientId } = req.query || {};
        await logAgentAccess('detail', { bookingId, clientId });
        return res.status(200).json(buildDetail(data, { bookingId, clientId }));
      }
      await logAgentAccess('unknown-view', { view: String(what).slice(0, 40) });
      return res.status(400).json({ error: 'Unknown view. Use summary, problems or detail.' });
    }
    // ------------------------------------------------------------------------------------------

    if (req.method === 'POST' && req.body && req.body.action === 'login') {
      const { password } = req.body;
      // Rate-limit failed admin logins to blunt brute-force — mirrors the client portal's lockout.
      // Keyed globally (single admin) rather than per-IP, since there's only one legitimate admin
      // and IPs are spoofable/shared; a short lockout is the pragmatic protection here.
      // Two counters, not one. The global counter alone meant any anonymous caller could burn
      // six guesses every fifteen minutes and keep the only administrator permanently locked out
      // of his own app. The per-caller counter is what actually stops guessing; the global one
      // is a much looser backstop against a distributed attempt.
      const failKey = 'admin-fail';
      const ipKey = 'admin-fail-ip:' + callerIp(req);
      const ipFails = Number(await kv.get(ipKey)) || 0;
      const fails = Number(await kv.get(failKey)) || 0;
      if (ipFails >= 6 || fails >= 40) {
        return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
      }
      if (!password || password !== process.env.ADMIN_PASSWORD) {
        await kv.set(ipKey, ipFails + 1, { ex: 900 });   // this caller, 15 minutes
        await kv.set(failKey, fails + 1, { ex: 900 });   // everyone, a far higher ceiling
        return res.status(401).json({ error: 'Incorrect password' });
      }
      await kv.del(ipKey);
      await kv.del(failKey); // clear on success
      const token = randomToken();
      // Expire after 12 hours. Previously these never expired, so any token that ever leaked —
      // through a log, a shared machine, browser recovery — stayed valid forever with no way
      // to revoke it. 12 hours covers a working day without a re-login mid-session.
      await kv.set('admin-session:' + token, true, { ex: ADMIN_SESSION_SECONDS });
      return res.status(200).json({ ok: true, token });
    }

    // Lets Manage actually end a session server-side rather than only forgetting it locally.
    if (req.method === 'POST' && req.body && req.body.action === 'logout') {
      const token = req.headers['x-admin-token'];
      if (token) await kv.del('admin-session:' + token);
      return res.status(200).json({ ok: true });
    }

    if (!(await verifyAdminToken(req))) return res.status(401).json({ error: 'Unauthorized' });

    // Nudge a client to take the strengths assessment: emails them a direct link carrying a
    // token that names only their own record, so they don't have to sign in or type anything.
    if (req.method === 'POST' && req.body?.action === 'send-strengths-invite') {
      const { clientId } = req.body;
      const data = await kv.get('app-data');
      const client = (data?.clients || []).find(c => c.id === clientId);
      if (!client) return res.status(404).json({ error: 'Client not found.' });
      if (!client.email) return res.status(400).json({ error: 'That client has no email address on file.' });
      try {
        const token = await issueScopedToken('strengths-invite', client.id, 60 * 60 * 24 * 60);
        const mail = strengthsInviteEmail(client, token);
        const sent = await sendEmail({ to: client.email, subject: mail.subject, html: mail.html });
        if (!sent) {
          await logError('send-strengths-invite', new Error('sendEmail reported failure'), { clientId });
          return res.status(502).json({ error: "The email didn't go out. Check the Problem log in Settings." });
        }
        const sentAtValue = Date.now();
        await mutate(fresh => {
          const c = (fresh.clients || []).find(x => x.id === clientId);
          if (!c) return SKIP_WRITE;
          c.strengthsInviteSentAt = sentAtValue;
        });
        client.strengthsInviteSentAt = sentAtValue;
        return res.status(200).json({ ok: true, sentAt: client.strengthsInviteSentAt, to: client.email });
      } catch (err) {
        await logError('send-strengths-invite', err, { clientId });
        return res.status(500).json({ error: 'Something went wrong sending that email.' });
      }
    }

    // Registers the webhook with Stripe using the secret key the app already holds, and stores
    // the signing secret Stripe returns. Nothing to do in the Stripe dashboard.
    if (req.method === 'POST' && req.body?.action === 'setup-stripe-webhook') {
      try {
        const url = (process.env.SITE_URL || 'https://heshy-booking.vercel.app') + '/api/stripe-webhook';
        const existing = await stripe.webhookEndpoints.list({ limit: 100 });
        for (const e of (existing.data || [])) {
          if (e.url === url) await stripe.webhookEndpoints.del(e.id);   // replace, don't duplicate
        }
        const created = await stripe.webhookEndpoints.create({
          url,
          enabled_events: STRIPE_EVENTS,
          description: 'Heshy booking app — refunds, disputes and late payment failures'
        });
        if (!created.secret) return res.status(500).json({ error: 'Stripe did not return a signing secret.' });
        await kv.set('stripe-webhook-secret', created.secret);
        await kv.set('stripe-webhook-id', created.id);
        return res.status(200).json({ ok: true, url, events: STRIPE_EVENTS.length });
      } catch (err) {
        await logError('setup-stripe-webhook', err, {});
        return res.status(500).json({ error: 'Could not set up the Stripe webhook: ' + err.message });
      }
    }
    if (req.query?.action === 'stripe-webhook-status' || req.body?.action === 'stripe-webhook-status') {
      const id = await kv.get('stripe-webhook-id');
      const hasSecret = !!(await kv.get('stripe-webhook-secret'));
      return res.status(200).json({ configured: hasSecret, id: id || null });
    }

    if (req.query?.action === 'secure-files' || req.body?.action === 'secure-files') {
      return handleSecureFiles(req, res);
    }

    if (req.query?.action === 'backups' || req.body?.action === 'backups') {
      return res.status(200).json({ entries: await listBackups() });
    }
    if (req.method === 'POST' && req.body?.action === 'backup-now') {
      const current = await readData();
      const entry = await takeBackup(current, 'manual');
      if (!entry) return res.status(500).json({ error: 'Could not take a backup just now.' });
      return res.status(200).json({ ok: true, entry });
    }
    if (req.query?.action === 'backup-download') {
      const snapshot = await readBackup(String(req.query.id || ''));
      if (!snapshot) return res.status(404).json({ error: 'No backup with that id.' });
      return res.status(200).json(snapshot);
    }
    if (req.method === 'POST' && req.body?.action === 'restore-backup') {
      const snapshot = await readBackup(String(req.body.id || ''));
      if (!snapshot) return res.status(404).json({ error: 'No backup with that id.' });
      // Snapshot what is there now first, so restoring is itself undoable.
      const current = await readData();
      await takeBackup(current, 'before-restore');
      await mutate(live => {
        Object.keys(live).forEach(k => { if (!(k in snapshot)) delete live[k]; });
        Object.keys(snapshot).forEach(k => { if (k !== 'version') live[k] = snapshot[k]; });
      });
      return res.status(200).json({ ok: true, restored: req.body.id });
    }

    if (req.body?.action === 'agent-log' || req.query?.action === 'agent-log') {
      return res.status(200).json({ entries: await readAgentLog(40) });
    }
    if (req.body?.action === 'error-log' || req.query?.action === 'error-log') {
      return res.status(200).json({ entries: await readErrors(60) });
    }
    if (req.method === 'POST' && req.body?.action === 'clear-error-log') {
      await clearErrors();
      return res.status(200).json({ ok: true });
    }
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
      // This used to write req.body straight over the entire business record, unchecked. Now it
      // is validated first, and saved under the lock against a fresh read — so a Manage tab left
      // open while a client books can no longer erase that booking, and a malformed save is
      // refused with a reason instead of flattening everything.
      const incoming = req.body;
      try {
        let shrinkSnapshot = null;
        const saved = await mutate(current => {
          const check = validateAppData({ ...incoming, __hadClients: (current.clients || []).length });
          if (!check.ok) { validationError = check.error; return SKIP_WRITE; }
          const next = check.data;
          // A save that removes records is the shape a mistake takes. Snapshot the current state
          // first so it can be put back, rather than discovering later that it is simply gone.
          if ((next.clients || []).length < (current.clients || []).length ||
              (next.bookings || []).length < (current.bookings || []).length) {
            shrinkSnapshot = JSON.parse(JSON.stringify(current));
          }
          // Keep the version line moving forward from whatever is actually stored.
          next.version = current.version || 0;
          Object.keys(current).forEach(k => { if (!(k in next)) next[k] = current[k]; });
          Object.keys(next).forEach(k => { current[k] = next[k]; });
          Object.keys(current).forEach(k => { if (!(k in next)) delete current[k]; });
          return true;
        }, { fallback: defaultState() });
        if (validationError) return res.status(400).json({ error: validationError });
        if (shrinkSnapshot) await takeBackup(shrinkSnapshot, 'before-removal');
        return res.status(200).json({ ok: true, saved: saved === true });
      } catch (err) {
        if (err.code === 'LOCK_TIMEOUT') return res.status(503).json({ error: err.message });
        throw err;
      }
    }
    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Server error:', err);
    await logError('admin-data', err, { method: req.method, action: req.body?.action || req.query?.action });
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
