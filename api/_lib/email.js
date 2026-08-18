const FROM = 'Heshy <bookings@catalystconsultingnyc.com>';
const REPLY_TO = 'heshy@catalystconsultingnyc.com';

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
    }
  } catch (e) {
    console.error('Email send failed:', e);
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

export function bookingConfirmationEmail(booking, settings) {
  const dateStr = new Date(booking.date + 'T' + booking.time + ':00').toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' });
  const timeStr = new Date(booking.date + 'T' + booking.time + ':00').toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
  const firstName = (booking.clientName || '').split(' ')[0];
  const meetLink = booking.meetLink || settings.meetLink;
  const joinRow = booking.type === 'virtual'
    ? factRow('Join link', meetLink ? `<a href="${meetLink}">${meetLink}</a>` : 'Sent before the session')
    : factRow('Location', ((booking.location || settings.location) || 'Sent before the session').replace(/\n/g, '<br>'));
  return {
    subject: `You're booked with Heshy — ${dateStr} at ${timeStr}`,
    html: wrap(`
      <div style="font-size:22px;font-family:Georgia,serif;margin-bottom:8px;">You're booked.</div>
      <div style="font-size:14px;font-family:Arial,sans-serif;color:#6E6E6E;margin-bottom:20px;">Hi ${firstName || 'there'} &mdash; your session with Heshy is confirmed. Here are the details:</div>
      <table style="width:100%;border-collapse:collapse;font-family:Arial,sans-serif;">
        ${factRow('Time', `${dateStr}, ${timeStr}`)}
        ${factRow('Format', booking.type === 'virtual' ? 'Video call' : 'In person')}
        ${factRow('Rate', booking.comped ? 'Complimentary — no charge' : '$500 per hour, charged after the session')}
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

export function newBookingAlertEmail(booking, settings, client) {
  const dateStr = new Date(booking.date + 'T' + booking.time + ':00').toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' });
  const timeStr = new Date(booking.date + 'T' + booking.time + ':00').toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
  const questions = (settings && settings.intakeQuestions) || [];
  const answers = (client && client.intakeAnswers) || booking.intakeAnswers || [];
  const wgPdfName = (client && client.wgPdfName) || booking.wgPdfName || '';
  let intakeHtml = '';
  questions.forEach((q, i) => {
    if (answers[i]) {
      intakeHtml += `<div style="margin-bottom:10px;"><div style="font-size:12.5px;color:#6E6E6E;">${q}</div><div style="font-size:13.5px;">${answers[i]}</div></div>`;
    }
  });
  const intakeBlock = intakeHtml
    ? `<div style="margin-top:20px;padding-top:16px;border-top:1px solid #DEDEDE;font-family:Arial,sans-serif;">
         <div style="font-size:13.5px;font-weight:bold;margin-bottom:10px;">Intake answers</div>
         ${intakeHtml}
       </div>`
    : '';
  const wgBlock = wgPdfName
    ? `<div style="margin-top:14px;font-family:Arial,sans-serif;font-size:13px;color:#6E6E6E;">Working Genius PDF uploaded: ${wgPdfName} (see Manage &rarr; Clients for the file)</div>`
    : '';
  return {
    subject: `New booking: ${booking.clientName}, ${dateStr}`,
    html: wrap(`
      <div style="font-size:20px;font-family:Georgia,serif;margin-bottom:16px;">New booking</div>
      <table style="width:100%;border-collapse:collapse;font-family:Arial,sans-serif;">
        ${factRow('Client', booking.clientName)}
        ${factRow('Email', booking.clientEmail)}
        ${factRow('Phone', booking.clientPhone)}
        ${factRow('Time', `${dateStr}, ${timeStr}`)}
        ${factRow('Format', booking.type === 'virtual' ? 'Video call' : 'In person')}
        ${booking.type === 'virtual' && booking.meetLink ? factRow('Join link', `<a href="${booking.meetLink}">${booking.meetLink}</a>`) : ''}
      </table>
      ${intakeBlock}
      ${wgBlock}
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
      <div style="font-size:14px;font-family:Arial,sans-serif;color:#6E6E6E;margin-bottom:20px;">Hi ${firstName || 'there'} &mdash; just a reminder about your upcoming session:</div>
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
      <strong>${timeStr}</strong> &mdash; ${b.clientName} &middot; ${b.type === 'virtual' ? 'Video call' : 'In person'}
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
