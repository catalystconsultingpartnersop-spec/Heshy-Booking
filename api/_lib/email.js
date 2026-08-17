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
    : factRow('Location', (settings.location || 'Sent before the session').replace(/\n/g, '<br>'));
  return {
    subject: `You're booked with Heshy — ${dateStr} at ${timeStr}`,
    html: wrap(`
      <div style="font-size:22px;font-family:Georgia,serif;margin-bottom:8px;">You're booked.</div>
      <div style="font-size:14px;font-family:Arial,sans-serif;color:#6E6E6E;margin-bottom:20px;">Hi ${firstName || 'there'} &mdash; your session with Heshy is confirmed. Here are the details:</div>
      <table style="width:100%;border-collapse:collapse;font-family:Arial,sans-serif;">
        ${factRow('Time', `${dateStr}, ${timeStr}`)}
        ${factRow('Format', booking.type === 'virtual' ? 'Video call' : 'In person')}
        ${factRow('Rate', '$500 per hour, charged after the session')}
        ${joinRow}
      </table>
    `)
  };
}

export function newBookingAlertEmail(booking) {
  const dateStr = new Date(booking.date + 'T' + booking.time + ':00').toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' });
  const timeStr = new Date(booking.date + 'T' + booking.time + ':00').toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
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
