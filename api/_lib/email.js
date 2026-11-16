import { profileOf } from './assessment.js';

const FROM = 'Heshy <bookings@catalystconsultingnyc.com>';
const REPLY_TO = 'heshy@catalystconsultingnyc.com';

// Escape user-supplied values before interpolating into email HTML, so a malicious
// name/email/phone can't inject markup into the message rendered in the owner's inbox.
function esc(v){
  if(v == null) return '';
  return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

export async function sendEmail({ to, subject, html }) {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: FROM,
        to: [to],
        subject,
        html,
        reply_to: REPLY_TO
      })
    });
    if (!res.ok) {
      console.error('Resend error:', await res.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error('Email send failed:', e);
    return false;
  }
}

function addMinutesLocal(dateStr, timeStr, minutesToAdd) {
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
function toCompact(dateStr, timeStr) {
  return dateStr.replace(/-/g, '') + 'T' + timeStr.replace(':', '') + '00';
}
function googleCalendarAddLink(booking, settings) {
  const end = addMinutesLocal(booking.date, booking.time, booking.durationMin || 60);
  const dates = toCompact(booking.date, booking.time) + '/' + toCompact(end.date, end.time);
  const details = booking.type === 'virtual'
    ? (booking.meetLink ? 'Join: ' + booking.meetLink : '')
    : (booking.location || settings.location || '');
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: 'Clarity session with Heshy',
    dates,
    ctz: 'America/New_York',
    details,
    location: booking.type === 'in-person' ? (booking.location || settings.location || '') : ''
  });
  return 'https://calendar.google.com/calendar/render?' + params.toString();
}

function factRow(label, value) {
  return `<tr><td style="padding:9px 0;border-bottom:1px solid #DEDEDE;color:#6E6E6E;font-size:13.5px;vertical-align:top;width:110px;">${label}</td><td style="padding:9px 0;border-bottom:1px solid #DEDEDE;text-align:right;font-size:13.5px;vertical-align:top;">${value}</td></tr>`;
}

function wrap(bodyHtml) {
  return `
  <div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#111111;">
    <div style="font-size:19px;font-weight:500;margin-bottom:28px;">Heshy — Clarity Sessions</div>
    ${bodyHtml}
    <div style="margin-top:32px;padding-top:16px;border-top:1px solid #DEDEDE;font-size:12px;color:#6E6E6E;font-family:Arial,sans-serif;">
      Catalyst Consulting Partners LLC
    </div>
  </div>`;
}

// Formats an Eastern wall-clock date+time for display, independent of the server's timezone.
function fmtEt(date, time) {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const asUtc = new Date(Date.UTC(y, mo - 1, d, h, mi));
  return {
    date: asUtc.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }),
    time: asUtc.toLocaleTimeString('en-US', { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' })
  };
}

// Sent to the client when Heshy moves a session. Until this existed, a rescheduled session
// was never communicated by the app at all.
export function rescheduledEmail(booking, previous, settings) {
  const now = fmtEt(booking.date, booking.time);
  const was = fmtEt(previous.date, previous.time);
  const firstName = esc((booking.clientName || '').split(' ')[0]);
  const meetLink = booking.meetLink || settings.meetLink;
  const whereRow = booking.type === 'virtual'
    ? factRow('Join link', meetLink ? `<a href="${esc(meetLink)}">${esc(meetLink)}</a>` : 'Sent before the session')
    : factRow('Location', esc(booking.location || settings.location || 'Sent before the session').replace(/\n/g, '<br>'));
  return {
    subject: `Your session has moved — now ${now.date} at ${now.time}`,
    html: wrap(`
      <div style="font-size:22px;font-family:Georgia,serif;margin-bottom:8px;">Your session has moved.</div>
      <div style="font-size:14px;font-family:Arial,sans-serif;color:#6E6E6E;margin-bottom:20px;">
        Hi ${firstName || 'there'} &mdash; Heshy has moved your session. Here are the new details.
      </div>
      <table style="width:100%;border-collapse:collapse;font-family:Arial,sans-serif;">
        ${factRow('New time', `<strong>${now.date}, ${now.time}</strong>`)}
        ${factRow('Was', `<span style="color:#6E6E6E;text-decoration:line-through;">${was.date}, ${was.time}</span>`)}
        ${factRow('Format', booking.type === 'virtual' ? 'Video call' : 'In person')}
        ${whereRow}
      </table>
      <div style="margin-top:22px;font-family:Arial,sans-serif;font-size:13px;">
        <a href="${esc(googleCalendarAddLink(booking, settings))}">Add the new time to your calendar</a>
      </div>
      <div style="margin-top:18px;font-size:13px;color:#6E6E6E;font-family:Arial,sans-serif;">
        If the new time doesn't work, just reply to this email.
      </div>
    `)
  };
}

export function bookingConfirmationEmail(booking, settings) {
  const dateStr = new Date(booking.date + 'T' + booking.time + ':00').toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' });
  const timeStr = new Date(booking.date + 'T' + booking.time + ':00').toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
  const firstName = (booking.clientName || '').split(' ')[0];
  const meetLink = booking.meetLink || settings.meetLink;
  const isQuickCheckin = booking.durationMin === 15;
  const joinRow = booking.type === 'virtual'
    ? factRow('Join link', meetLink ? `<a href="${meetLink}">${meetLink}</a>` : 'Sent before the session')
    : factRow('Location', ((booking.location || settings.location) || 'Sent before the session').replace(/\n/g, '<br>'));
  return {
    subject: `You're booked with Heshy — ${dateStr} at ${timeStr}`,
    html: wrap(`
      <div style="font-size:22px;font-family:Georgia,serif;margin-bottom:8px;">You're booked.</div>
      <div style="font-size:14px;font-family:Arial,sans-serif;color:#6E6E6E;margin-bottom:20px;">Hi ${esc(firstName) || 'there'} &mdash; your session with Heshy is confirmed. Here are the details:</div>
      <table style="width:100%;border-collapse:collapse;font-family:Arial,sans-serif;">
        ${factRow('Time', `${dateStr}, ${timeStr}`)}
        ${factRow('Format', isQuickCheckin ? 'Phone call' : (booking.type === 'virtual' ? 'Video call' : 'In person'))}
        ${factRow('Rate', booking.comped ? 'Complimentary — no charge' : `$${settings.hourlyRate||500} per hour, charged after the session`)}
        ${joinRow}
      </table>
      ${isQuickCheckin ? `<div style="margin-top:16px;padding:13px 16px;background:#FAF7F0;border-left:3px solid #C9A961;border-radius:4px;font-family:Arial,sans-serif;font-size:13px;line-height:1.6;color:#5C4A20;">You don't need to call in &mdash; Heshy will call you directly at ${timeStr}. If he can't reach you, he'll try again about a minute later. If there's still no answer and the session hasn't been cancelled ahead of time, it will still be billed for the ${booking.durationMin} minutes reserved.</div>` : ''}
      <div style="margin-top:20px;font-family:Arial,sans-serif;font-size:13.5px;">
        <a href="${googleCalendarAddLink(booking, settings)}" style="color:#111111;text-decoration:underline;">Add to calendar</a>
        &middot;
        <a href="${(process.env.SITE_URL || 'https://heshy-booking.vercel.app')}/#portal" style="color:#111111;text-decoration:underline;">View my sessions</a>
      </div>
      <div style="margin-top:22px;padding-top:16px;border-top:1px solid #E6E6E6;font-family:Arial,sans-serif;font-size:12.5px;color:#6E6E6E;line-height:1.6;">
        Sessions are sometimes recorded so Heshy can focus on the conversation and send you a written recap.
        He'll always tell you first, and you can say no.
        <a href="${(process.env.SITE_URL || 'https://heshy-booking.vercel.app')}/privacy.html" style="color:#111111;">How your information is handled</a>.
      </div>
    `)
  };
}

export function newBookingAlertEmail(booking, settings, client) {
  const dateStr = new Date(booking.date + 'T' + booking.time + ':00').toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' });
  const timeStr = new Date(booking.date + 'T' + booking.time + ':00').toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
  const questions = (settings && settings.intakeQuestions) || [];
  const answers = (client && client.intakeAnswers) || booking.intakeAnswers || [];
  const wgPdfName = (client && client.wgPdfName) || booking.wgPdfName || '';
  let intakeHtml = '';
  questions.forEach((q, i) => {
    if (answers[i]) {
      intakeHtml += `<div style="margin-bottom:10px;"><div style="font-size:12.5px;color:#6E6E6E;">${esc(q)}</div><div style="font-size:13.5px;">${esc(answers[i])}</div></div>`;
    }
  });
  const intakeBlock = intakeHtml
    ? `<div style="margin-top:20px;padding-top:16px;border-top:1px solid #DEDEDE;font-family:Arial,sans-serif;">
         <div style="font-size:13.5px;font-weight:bold;margin-bottom:10px;">Intake answers</div>
         ${intakeHtml}
       </div>`
    : '';
  const wgLetters = ((client && client.wgLetters) || '').toUpperCase();
  // Three distinct states, so the alert always says something definite about the assessment
  // rather than staying silent when nothing is on file.
  const profile = wgLetters ? profileOf(wgLetters) : null;
  const wgText = (profile && profile.complete)
    ? `Strengths: <strong style="color:#111111;letter-spacing:0.08em;">${esc(wgLetters)}</strong>`
        + (profile.type ? ` &mdash; ${esc(profile.type.name)}` : '')
    : wgPdfName
      ? `Older Working Genius PDF on file: ${esc(wgPdfName)} &mdash; no strengths result entered yet (open the client to add them)`
      : `No strengths assessment on file for this client yet.`;
  const wgBlock = `<div style="margin-top:14px;font-family:Arial,sans-serif;font-size:13px;color:#6E6E6E;">${wgText}</div>`;
  const baseUrl = process.env.SITE_URL || 'https://heshy-booking.vercel.app';
  const profileBlock = (client && client.id)
    ? `<div style="margin-top:18px;font-family:Arial,sans-serif;font-size:13.5px;">
         <a href="${baseUrl}/#manage/client/${encodeURIComponent(client.id)}" style="color:#111111;text-decoration:underline;">Open ${esc((booking.clientName || '').split(' ')[0] || 'client')}&rsquo;s profile</a>
       </div>`
    : '';
  return {
    subject: `New booking: ${esc(booking.clientName)}, ${dateStr}`,
    html: wrap(`
      <div style="font-size:20px;font-family:Georgia,serif;margin-bottom:16px;">New booking</div>
      <table style="width:100%;border-collapse:collapse;font-family:Arial,sans-serif;">
        ${factRow('Client', esc(booking.clientName))}
        ${factRow('Email', esc(booking.clientEmail))}
        ${factRow('Phone', esc(booking.clientPhone))}
        ${factRow('Time', `${dateStr}, ${timeStr}`)}
        ${factRow('Format', booking.type === 'virtual' ? 'Video call' : 'In person')}
        ${booking.type === 'virtual' && booking.meetLink ? factRow('Join link', `<a href="${booking.meetLink}">${booking.meetLink}</a>`) : ''}
      </table>
      ${intakeBlock}
      ${wgBlock}
      ${profileBlock}
    `)
  };
}

export function receiptEmail(booking) {
  const mins = booking.actualMinutes || booking.durationMin;
  return {
    subject: `Receipt — $${(booking.amount || 0).toFixed(2)}`,
    html: wrap(`
      <div style="font-size:20px;font-family:Georgia,serif;margin-bottom:16px;">Receipt</div>
      <table style="width:100%;border-collapse:collapse;font-family:Arial,sans-serif;">
        ${factRow('Date', booking.date)}
        ${factRow('Duration', mins + ' min')}
        ${factRow('Charged', '$' + (booking.amount || 0).toFixed(2))}
      </table>
      ${booking.clientSummary ? `<div style="margin-top:20px;font-family:Arial,sans-serif;font-size:13.5px;line-height:1.6;">${booking.clientSummary}</div>` : ''}
    `)
  };
}

export function reminderEmail(booking, settings) {
  const dateStr = new Date(booking.date + 'T' + booking.time + ':00').toLocaleDateString('en-US', { weekday:'long', month:'short', day:'numeric' });
  const timeStr = new Date(booking.date + 'T' + booking.time + ':00').toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
  const firstName = (booking.clientName || '').split(' ')[0];
  const meetLink = booking.meetLink || settings.meetLink;
  const joinRow = booking.type === 'virtual'
    ? factRow('Join link', meetLink ? `<a href="${meetLink}">${meetLink}</a>` : 'Sent before the session')
    : factRow('Location', ((booking.location || settings.location) || 'Sent before the session').replace(/\n/g, '<br>'));
  return {
    subject: `Reminder — your session with Heshy is tomorrow`,
    html: wrap(`
      <div style="font-size:22px;font-family:Georgia,serif;margin-bottom:8px;">See you tomorrow.</div>
      <div style="font-size:14px;font-family:Arial,sans-serif;color:#6E6E6E;margin-bottom:20px;">Hi ${esc(firstName) || 'there'} &mdash; just a reminder about your upcoming session:</div>
      <table style="width:100%;border-collapse:collapse;font-family:Arial,sans-serif;">
        ${factRow('Time', `${dateStr}, ${timeStr}`)}
        ${factRow('Format', booking.type === 'virtual' ? 'Video call' : 'In person')}
        ${joinRow}
      </table>
      <div style="margin-top:20px;font-family:Arial,sans-serif;font-size:13.5px;">
        <a href="${googleCalendarAddLink(booking, settings)}" style="color:#111111;text-decoration:underline;">Add to calendar</a>
        &middot;
        <a href="${(process.env.SITE_URL || 'https://heshy-booking.vercel.app')}/#portal" style="color:#111111;text-decoration:underline;">View my sessions</a>
      </div>
    `)
  };
}

export function dailyDigestEmail(todayBookings, tomorrowBookings) {
  const row = b => {
    const timeStr = new Date(b.date + 'T' + b.time + ':00').toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
    return `<div style="padding:8px 0;border-bottom:1px solid #DEDEDE;font-family:Arial,sans-serif;font-size:13.5px;">
      <strong>${timeStr}</strong> &mdash; ${esc(b.clientName)} &middot; ${b.type === 'virtual' ? 'Video call' : 'In person'}
    </div>`;
  };
  const section = (label, list) => `
    <div style="margin-top:20px;">
      <div style="font-size:14px;font-weight:bold;font-family:Arial,sans-serif;margin-bottom:6px;">${label} (${list.length})</div>
      ${list.length ? list.map(row).join('') : `<div style="font-family:Arial,sans-serif;font-size:13.5px;color:#6E6E6E;">Nothing scheduled.</div>`}
    </div>`;
  return {
    subject: `Your schedule: ${todayBookings.length} today, ${tomorrowBookings.length} tomorrow`,
    html: wrap(`
      <div style="font-size:22px;font-family:Georgia,serif;margin-bottom:8px;">Good morning.</div>
      <div style="font-size:14px;font-family:Arial,sans-serif;color:#6E6E6E;">Here's your schedule for today and tomorrow.</div>
      ${section('Today', todayBookings)}
      ${section('Tomorrow', tomorrowBookings)}
    `)
  };
}

/**
 * The nudge Heshy sends from Manage: a direct link into the strengths assessment, with the
 * client's invite token in it, so they can start without signing in or typing anything.
 */
export function strengthsInviteEmail(client, token) {
  const baseUrl = process.env.SITE_URL || 'https://heshy-booking.vercel.app';
  const link = `${baseUrl}/?strengths=${encodeURIComponent(token)}`;
  const firstName = (client.name || '').split(' ')[0];
  return {
    subject: 'A short assessment before our session',
    html: wrap(`
      <div style="font-size:22px;font-family:Georgia,serif;margin-bottom:8px;">Before we meet</div>
      <div style="font-size:14px;font-family:Arial,sans-serif;color:#3C3C3C;line-height:1.65;margin-bottom:16px;">
        Hi ${esc(firstName) || 'there'} &mdash; I'd like you to spend about ten minutes on this before our session.
      </div>
      <div style="font-size:14px;font-family:Arial,sans-serif;color:#3C3C3C;line-height:1.65;margin-bottom:16px;">
        It tells me how you're actually wired &mdash; what energises you, what you're good at, and what quietly
        drains you. Without it, I spend the first part of our time working that out. With it, we start at the
        real conversation.
      </div>
      <div style="padding:14px 16px;background:#FAF7F0;border-left:3px solid #C9A961;border-radius:4px;font-family:Arial,sans-serif;font-size:13.5px;line-height:1.65;color:#5C4A20;margin-bottom:22px;">
        This used to cost money. I built my own version so I can give it to you as part of working together,
        at no charge.
      </div>
      <div style="font-family:Arial,sans-serif;margin-bottom:18px;">
        <a href="${link}" style="display:inline-block;background:#111111;color:#FFFFFF;text-decoration:none;
           font-size:14px;padding:13px 26px;border-radius:6px;">Start the assessment</a>
      </div>
      <div style="font-family:Arial,sans-serif;font-size:12.5px;color:#6E6E6E;line-height:1.6;">
        There's nothing to study for and no wrong answers &mdash; answer how you actually feel, not how you
        think you should. If the button doesn't work, paste this into your browser:<br>
        <span style="color:#3C3C3C;word-break:break-all;">${esc(link)}</span>
      </div>
      <div style="font-family:Arial,sans-serif;font-size:13.5px;color:#3C3C3C;margin-top:22px;">Thanks,<br>Heshy</div>
    `)
  };
}
