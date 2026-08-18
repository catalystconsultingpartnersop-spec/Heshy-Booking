import { kv } from '@vercel/kv';
import { verifyAdminToken } from './_lib/auth.js';

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

function extractMeetingCode(meetLink) {
  if (!meetLink) return null;
  const parts = meetLink.split('/').filter(Boolean);
  return parts[parts.length - 1] || null;
}

async function fetchActualDurationFromMeet(accessToken, meetLink) {
  const meetingCode = extractMeetingCode(meetLink);
  if (!meetingCode) return { minutes: null, reason: 'No meeting link on this booking.' };
  try {
    const filter = encodeURIComponent(`space.meeting_code = "${meetingCode}"`);
    const r = await fetch(`https://meet.googleapis.com/v2/conferenceRecords?filter=${filter}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return { minutes: null, reason: `Meet API error (${r.status}): ${body.slice(0, 200)}` };
    }
    const data = await r.json();
    const record = (data.conferenceRecords || [])[0];
    if (!record) return { minutes: null, reason: 'No Google Meet conference record found yet — it can take a few minutes to appear after the call ends.' };
    if (!record.startTime || !record.endTime) return { minutes: null, reason: 'The call may still be in progress, or the record is incomplete.' };
    const mins = Math.max(1, Math.round((new Date(record.endTime) - new Date(record.startTime)) / 60000));
    return { minutes: mins, reason: null };
  } catch (e) {
    return { minutes: null, reason: 'Could not reach the Meet API: ' + e.message };
  }
}

function extractSummary(text) {
  const match = text.match(/Summary\s*\n([\s\S]*?)(?=\n\s*(?:Details|Transcript|Action items|Suggested next steps)\b|$)/i);
  const summary = match ? match[1].trim() : '';
  return summary || text.slice(0, 1500).trim();
}

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
          { role: 'system', content: 'You write a short, warm summary of a coaching/consulting session for the CLIENT to read themselves in their portal. 2-4 sentences, plain language, no headers or bullet points, no internal admin details (billing, scheduling notes, anything not meant for the client). Just a friendly recap of what was covered.' },
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

// Virtual-call notes come from Gemini (works regardless of which device joins the call) —
// in-person notes come from our own recording pipeline instead, since Gemini has no equivalent
// there. This endpoint also confirms the real call duration from Google's own conference record.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    if (!(await verifyAdminToken(req))) return res.status(401).json({ error: 'Unauthorized' });
    const { bookingId } = req.body || {};
    const data = await kv.get('app-data');
    if (!data) return res.status(404).json({ error: 'No data found' });

    const booking = data.bookings.find(b => b.id === bookingId);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (!booking.calendarEventId && !booking.meetLink) return res.status(400).json({ error: 'No calendar event or meeting link on this booking.' });

    const accessToken = await getGoogleAccessToken();
    if (!accessToken) return res.status(400).json({ error: 'Google Calendar is not connected.' });

    // Duration — independent of whether Gemini's notes doc exists yet.
    const { minutes: meetMinutes, reason } = await fetchActualDurationFromMeet(accessToken, booking.meetLink);
    const hadManualDuration = booking.actualMinutes != null;
    let durationNote;
    if (meetMinutes) {
      booking.actualMinutes = meetMinutes; // Google's own record is authoritative; safe to override the timer.
      durationNote = `Duration confirmed by Google Meet: ${meetMinutes} min.`;
    } else {
      durationNote = reason || 'Could not confirm duration from Google Meet.';
      durationNote += hadManualDuration ? ` Keeping your timer's ${booking.actualMinutes} min for now.` : ' Use the Start/Stop timer to track actual time until this becomes available.';
    }

    // Notes — from Gemini's notes doc attached to the Calendar event, if it's ready yet.
    let notesNote = '';
    if (booking.calendarEventId) {
      const evRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${booking.calendarEventId}`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const event = await evRes.json();
      const docAttachment = (event.attachments || []).find(a => a.mimeType === 'application/vnd.google-apps.document');
      if (docAttachment && docAttachment.fileId) {
        const exportRes = await fetch(`https://www.googleapis.com/drive/v3/files/${docAttachment.fileId}/export?mimeType=text/plain`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        if (exportRes.ok) {
          const text = await exportRes.text();
          const summary = extractSummary(text);
          booking.summary = summary;
          const clientVersion = await generateClientFacingSummary(summary);
          if (clientVersion) booking.clientSummary = clientVersion;
          notesNote = 'Notes fetched.';
        } else {
          notesNote = 'Found the notes doc, but could not read it yet.';
        }
      } else {
        notesNote = "Notes aren't ready yet — Gemini usually takes a few minutes after the call ends.";
      }
    } else {
      notesNote = 'No calendar event linked, so notes could not be fetched — duration was still checked.';
    }

    await kv.set('app-data', data);
    res.status(200).json({
      ok: true,
      foundDuration: !!meetMinutes,
      actualMinutes: booking.actualMinutes || null,
      summary: booking.summary || '',
      note: `${notesNote} ${durationNote}`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
