// What happened to an email after it left.
//
// "The client has been emailed" only ever meant Resend accepted it. It didn't mean the message
// arrived, and it certainly didn't mean anyone read it. The outcome that matters most is the one
// that was invisible: a bounce. A wrong address on file would leave Heshy waiting for a payment
// that nobody was ever asked for.
//
// Resend reports delivery through a webhook signed by Svix. This module verifies that signature
// and turns an event into a status on the booking the email belongs to.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mutate, SKIP_WRITE } from './store.js';

/**
 * Verifies a Svix-signed webhook body.
 *
 * The signed string is `${id}.${timestamp}.${raw body}` — the body exactly as received, which is
 * why the endpoint must read it raw rather than letting a parser near it. The secret is base64
 * after its `whsec_` prefix. The header can carry several space-separated signatures (Svix sends
 * one per active key during rotation); any one matching is enough.
 */
export function verifySvix(rawBody, headers, secret) {
  if (!secret) return false;
  const id = headers['svix-id'];
  const timestamp = headers['svix-timestamp'];
  const signature = headers['svix-signature'];
  if (!id || !timestamp || !signature) return false;

  // A replayed request is refused even with a valid signature.
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;

  let key;
  try {
    key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');
  } catch (e) { return false; }
  if (!key.length) return false;

  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest();
  for (const part of String(signature).split(' ')) {
    if (!part.startsWith('v1,')) continue;
    let given;
    try { given = Buffer.from(part.slice(3), 'base64'); } catch (e) { continue; }
    // Compared in constant time, and only when the lengths match — timingSafeEqual throws
    // otherwise, which would itself leak the length.
    if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
  }
  return false;
}

// What each event means in plain words, and whether it is something Heshy needs to act on.
// Ordered by finality: a later state never gets overwritten by an earlier one, so an "opened"
// that arrives before its "delivered" doesn't get downgraded.
// `label` is a short state the time can be appended to ("Bounced at 3:01 PM"); `detail` is the
// explanation, on its own line, and only where there is something to explain.
const STATES = {
  'email.sent':             { rank: 1, label: 'Sent' },
  'email.delivery_delayed': { rank: 2, label: 'Delayed', problem: true,
                              detail: "Their mail server is being slow to accept it. It may still arrive." },
  'email.delivered':        { rank: 3, label: 'Delivered' },
  'email.opened':           { rank: 4, label: 'Opened' },
  'email.clicked':          { rank: 5, label: 'Clicked the link' },
  // The two that actually need Heshy. A bounce means nobody will ever see it.
  'email.bounced':          { rank: 6, label: 'Bounced', problem: true,
                              detail: "That address didn't accept it, so they never got it. Check the address on file." },
  'email.complained':       { rank: 7, label: 'Marked as spam', problem: true,
                              detail: 'Further emails may not reach them.' }
};

export function statusFor(type) {
  return STATES[type] || null;
}

/**
 * Records an event against whichever booking the email belongs to.
 *
 * Matched on the Resend message id stored when the email was sent, so an event can never be
 * credited to the wrong session. Returns a short note for the log.
 */
export async function applyEmailEvent(event) {
  const type = event?.type;
  const state = statusFor(type);
  if (!state) return `ignored ${type || 'an event with no type'}`;

  const emailId = event?.data?.email_id;
  if (!emailId) return 'no email id on the event';

  let note = 'no matching email';
  await mutate(data => {
    const booking = (data.bookings || []).find(b => b.declineEmail && b.declineEmail.id === emailId);
    if (!booking) return SKIP_WRITE;

    const current = booking.declineEmail.rank || 0;
    // An opened email that is later reported delivered must not go backwards. Bounces and spam
    // complaints always win, because they are the ones Heshy has to do something about.
    if (state.rank < current && !state.problem) {
      note = `${state.label} ignored; already ${booking.declineEmail.status}`;
      return SKIP_WRITE;
    }

    booking.declineEmail.status = state.label;
    booking.declineEmail.detail = state.detail || '';
    booking.declineEmail.problem = !!state.problem;
    booking.declineEmail.rank = Math.max(current, state.rank);
    booking.declineEmail.statusAt = Date.parse(event.created_at || '') || Date.now();
    if (type === 'email.opened') booking.declineEmail.opened = true;
    note = `${state.label} recorded`;
  });
  return note;
}
