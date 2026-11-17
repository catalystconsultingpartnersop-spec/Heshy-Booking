// Pay links: a one-session-one-link way for a client to pay the amount owed themselves.
//
// The reason this exists is narrower than it looks. Charging a saved card off-session — the
// client nowhere near their phone — is exactly the shape banks decline for fraud. A $1,000
// charge appearing with nobody confirming it is what produced `do_not_honor` from Chase. When
// the cardholder opens a link and presses Pay, the bank sees them approving it and can run 3-D
// Secure, which is the thing that actually clears the decline. Same card, same money.
//
// The token carries no amount. It names a booking, and the amount is worked out from that
// booking at the moment the page is opened, so a link can't be edited into a different price
// and can't go stale if the length is corrected after the email went out.
import { kv } from '@vercel/kv';
import { randomBytes } from 'node:crypto';
import { computeCharge } from './billing.js';

const PREFIX = 'pay-token:';
export const PAY_TOKEN_SECONDS = 60 * 60 * 24 * 30;   // a month; an unpaid invoice outlives a week

/**
 * One live link per booking. Re-issuing returns the existing token rather than minting a second
 * one, so a client who gets two emails doesn't end up with two links where only the newer works
 * — and an old email keeps working for the full month.
 */
export async function issuePayToken(bookingId) {
  if (!bookingId) return null;
  const existingKey = `pay-token-for:${bookingId}`;
  const existing = await kv.get(existingKey);
  if (existing && await kv.get(PREFIX + existing)) return existing;

  const token = randomBytes(24).toString('hex');
  await kv.set(PREFIX + token, { bookingId, issuedAt: Date.now() }, { ex: PAY_TOKEN_SECONDS });
  await kv.set(existingKey, token, { ex: PAY_TOKEN_SECONDS });
  return token;
}

/** The booking a token refers to, or null if it never existed or has expired. */
export async function readPayToken(token) {
  if (!token || typeof token !== 'string' || token.length < 24) return null;
  const rec = await kv.get(PREFIX + token);
  return rec?.bookingId || null;
}

export async function revokePayToken(token, bookingId) {
  await kv.del(PREFIX + token);
  if (bookingId) await kv.del(`pay-token-for:${bookingId}`);
}

/**
 * What the link should show, worked out fresh. Returns a `state` the page can act on rather
 * than an error string, because "already paid" and "cancelled" are normal things for a client
 * to arrive at — the link outlives the problem it was sent about.
 */
export function payableFor(data, bookingId) {
  const booking = (data?.bookings || []).find(b => b.id === bookingId);
  if (!booking) return { state: 'unknown' };
  if (booking.cancelled) return { state: 'cancelled', booking };
  if (booking.status === 'charged') return { state: 'paid', booking, amount: booking.amount || 0 };
  if (booking.comped) return { state: 'comped', booking };

  const quote = computeCharge(booking, data.settings || {});
  if (!quote.cents) return { state: 'nothing-owed', booking };
  return {
    state: 'owed',
    booking,
    cents: quote.cents,
    amount: quote.cents / 100,
    minutes: quote.minutes,
    discounted: quote.discounted
  };
}
