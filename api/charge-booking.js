import { kv } from '@vercel/kv';
import { mutate, SKIP_WRITE } from './_lib/store.js';
import { verifyAdminToken } from './_lib/auth.js';
import { sendEmail, receiptEmail, chargeDeclinedEmail } from './_lib/email.js';
import { logError } from './_lib/errorlog.js';
import { stripe, defaultCardFor } from './_lib/stripecustomer.js';
import { computeCharge } from './_lib/billing.js';
import { issuePayToken } from './_lib/paylink.js';

// Turns a Stripe card error into something Heshy can act on. Each case says what happened and
// what to do about it, because "declined" alone leaves him with no next step.
//
// `retryable: false` means the same card will keep failing — retrying is a waste of a call to
// the bank and, on repeated attempts, counts against the card. Those cases need a new card or
// the client's involvement, not another press of the button.
export function explainDecline(err) {
  const code = err?.code === 'authentication_required'
    ? 'authentication_required'
    : (err?.decline_code || err?.code || 'generic_decline');

  const CASES = {
    // Not really a decline: the bank wants the cardholder present to approve it (3-D Secure).
    // Charging off-session can never satisfy that, so retrying is pointless.
    authentication_required: {
      message: "The client's bank wants them to approve this payment themselves.",
      next: 'Ask them to update their card in the portal — confirming it there authorises future charges.',
      retryable: false
    },
    insufficient_funds: {
      message: 'The card was declined: not enough available funds.',
      next: 'Worth trying again in a day or two, or ask them for a different card.',
      retryable: true
    },
    expired_card: {
      message: 'The card on file has expired.',
      next: 'Ask them to update their card in the portal.',
      retryable: false
    },
    incorrect_cvc: {
      message: "The card's security code was rejected.",
      next: 'Ask them to re-enter the card in the portal.',
      retryable: false
    },
    card_velocity_exceeded: {
      message: 'The card has hit its limit on recent transactions.',
      next: 'Try again tomorrow, or ask them for a different card.',
      retryable: true
    },
    lost_card:   { message: 'The bank has reported this card lost.',   next: 'Ask them for a different card.', retryable: false },
    stolen_card: { message: 'The bank has reported this card stolen.', next: 'Ask them for a different card.', retryable: false },
    pickup_card: { message: 'The bank has blocked this card.',         next: 'Ask them for a different card.', retryable: false },
    do_not_honor: {
      message: "The card was declined by the client's bank, without a reason given.",
      next: "This usually means the bank blocked it, not that anything is wrong on your side. Ask them to call their bank, or for a different card.",
      retryable: true
    },
    transaction_not_allowed: {
      message: "The card doesn't allow this kind of payment.",
      next: 'Ask them for a different card.',
      retryable: false
    },
    currency_not_supported: {
      message: "The card doesn't support charges in US dollars.",
      next: 'Ask them for a different card.',
      retryable: false
    }
  };

  const hit = CASES[code];
  if (hit) return { code, ...hit };
  return {
    code,
    // Stripe's own wording is better than a guess for anything not listed above.
    message: err?.message || 'The card was declined.',
    next: "Ask the client to check with their bank, or to add a different card in the portal.",
    retryable: true
  };
}

/**
 * Emails the client about a declined card, at most once per booking per reason.
 *
 * The cap matters: pressing Charge four times on a card the bank keeps refusing would otherwise
 * send the client four identical "your card didn't go through" emails, which is worse than
 * sending none. A *different* decline reason is genuinely new information, so that does send.
 *
 * Returns what actually happened, so Manage can say so rather than imply an email went out.
 */
async function notifyClientOfDecline(bookingId, d, err) {
  try {
    const data = await kv.get('app-data');
    const booking = (data?.bookings || []).find(b => b.id === bookingId);
    if (!booking || !booking.clientEmail) return 'no-email';

    const seenKey = `decline-notified:${bookingId}:${d.code}`;
    // SET NX: the first caller wins, so a double-click can't send two.
    const first = await kv.set(seenKey, Date.now(), { nx: true, ex: 60 * 60 * 24 * 14 });
    if (!first) return 'already-sent';

    const amountCents = err?.payment_intent?.amount ?? err?.raw?.payment_intent?.amount ?? null;
    // A link the client can pay through themselves. For the declines this app actually sees —
    // a bank refusing a charge that arrives with no cardholder attached — this is the thing
    // that clears it, so the email leads with it rather than only offering a card swap.
    const payToken = await issuePayToken(bookingId).catch(() => null);
    const baseUrl = process.env.SITE_URL || 'https://heshy-booking.vercel.app';
    const payUrl = payToken ? `${baseUrl}/#pay/${payToken}` : '';
    const mail = chargeDeclinedEmail(
      booking,
      { ...d, amount: amountCents != null ? amountCents / 100 : (booking.amount || 0) },
      data?.settings || {},
      payUrl
    );
    const sent = await sendEmail({ to: booking.clientEmail, subject: mail.subject, html: mail.html });
    if (!sent) {
      // The send failed, so let a retry try again rather than suppressing it for a fortnight.
      await kv.del(seenKey);
      return 'failed';
    }
    await mutate(fresh => {
      const b = (fresh.bookings || []).find(x => x.id === bookingId);
      if (!b) return SKIP_WRITE;
      b.declineNotifiedAt = Date.now();
      b.lastDeclineCode = d.code;
      // Resend's id for the message, so the delivery webhook can report back against this
      // booking. Without it, "emailed" would stay the end of the story.
      b.declineEmail = {
        id: typeof sent === 'string' ? sent : null,
        to: booking.clientEmail,
        sentAt: Date.now(),
        status: 'Sent',
        detail: '',
        rank: 1,
        problem: false
      };
    });
    return 'sent';
  } catch (e) {
    // Never let the notification break the charge response — Heshy still needs to be told the
    // card was declined, even if the client couldn't be.
    console.error('Decline notification failed:', e);
    return 'failed';
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    if (!(await verifyAdminToken(req))) return res.status(401).json({ error: 'Unauthorized' });
    const { bookingId, amount, actualMinutes } = req.body;
    const data = await kv.get('app-data');
    if (!data) return res.status(404).json({ error: 'No data found' });

    const booking = data.bookings.find(b => b.id === bookingId);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    // Guard against double-charging (double-click, network retry, etc.) — a booking that's
    // already been charged must never be charged again.
    if (booking.status === 'charged') return res.status(400).json({ error: 'This session has already been charged.' });
    if (booking.cancelled) return res.status(400).json({ error: 'This session was cancelled.' });

    if (typeof actualMinutes === 'number' && !isNaN(actualMinutes) && actualMinutes >= 0) {
      booking.actualMinutes = actualMinutes;
    }

    // The amount comes from the booking's own saved terms — billing mode, the hours actually
    // worked, and any coupon or complimentary status recorded when it was booked. It used to be
    // whatever Manage sent, which meant editing the hours silently recalculated at full price
    // and dropped the discount.
    const quote = computeCharge(booking, data.settings || {});
    const mins = quote.minutes;

    // A complimentary session never touches a card. It used to show normal charge controls, so
    // one wrong click billed a free session in full.
    if (quote.comped) {
      await mutate(fresh => {
        const b = (fresh.bookings || []).find(x => x.id === bookingId);
        if (!b) return SKIP_WRITE;
        b.status = 'charged'; b.amount = 0; b.actualMinutes = mins;
      });
      return res.status(200).json({ ok: true, amount: 0, comped: true });
    }

    let amountCents = quote.cents;
    let overridden = false;
    if (typeof amount === 'number' && !isNaN(amount) && amount >= 0) {
      const requested = Math.round(amount * 100);
      overridden = requested !== quote.cents;
      amountCents = requested;
    }
    // Defense-in-depth ceiling: even though this endpoint is admin-only, never allow a single
    // charge beyond a sane maximum, so a bug or compromised session can't trigger a runaway charge.
    // Cap is the greater of $5,000 or 3x the computed default for this session, whichever is higher.
    const MAX_CENTS = Math.max(500000, quote.cents * 3);
    if (amountCents > MAX_CENTS) {
      return res.status(400).json({ error: 'That charge amount looks too high — please double-check and try again.' });
    }

    if (!booking.stripeCustomerId) return res.status(400).json({ error: 'No card on file for this booking' });
    // The customer's default card, not whichever one Stripe happened to list first.
    const paymentMethodId = await defaultCardFor(booking.stripeCustomerId);
    if (!paymentMethodId) {
      return res.status(400).json({ error: 'No saved card found for this customer' });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      customer: booking.stripeCustomerId,
      payment_method: paymentMethodId,
      off_session: true,
      confirm: true,
      receipt_email: booking.clientEmail,
      description: `Clarity session, ${mins} min, ${booking.date}`
    }, {
      // Idempotency key tied to booking + amount + the specific card: an accidental double-submit
      // (same card, same amount) can never double-charge, but if a charge is declined and the
      // client saves a NEW card, the key changes and the retry genuinely attempts the new card
      // instead of replaying Stripe's cached decline from the old one.
      idempotencyKey: `charge-${booking.id}-${amountCents}-${paymentMethodId}`
    });

    // The charge has already gone through at Stripe, so this must record it. Written under the
    // lock against a fresh read, so a booking saved elsewhere in the meantime isn't erased by
    // writing back the copy this request loaded a few seconds ago.
    booking.status = 'charged';
    booking.amount = amountCents / 100;
    booking.actualMinutes = mins;
    booking.stripePaymentIntentId = paymentIntent.id;
    if (overridden) booking.amountOverridden = true;
    await mutate(fresh => {
      const b = (fresh.bookings || []).find(x => x.id === bookingId);
      if (!b) return SKIP_WRITE;
      b.status = 'charged';
      b.amount = amountCents / 100;
      b.actualMinutes = mins;
      b.stripePaymentIntentId = paymentIntent.id;
      if (overridden) b.amountOverridden = true;
    });

    try {
      const receipt = receiptEmail(booking);
      await sendEmail({ to: booking.clientEmail, subject: receipt.subject, html: receipt.html });
    } catch (e) { /* email is best-effort */ }

    res.status(200).json({ ok: true, amount: amountCents / 100 });
  } catch (err) {
    console.error('Charge error:', err);
    await logError('charge-booking', err, {
      bookingId: req.body?.bookingId, amount: req.body?.amount,
      // Recorded so a decline can be looked into afterwards, rather than only being seen once
      // in an alert box that nobody wrote down.
      declineCode: err?.decline_code || err?.code || undefined
    });
    // Surface Stripe's card-decline reason (safe, user-facing) but nothing internal.
    // "The card was declined" on its own is useless: an expired card, a card over its limit and
    // a card whose bank wants the cardholder present are three different problems with three
    // different fixes, and Stripe tells us which one it is.
    if (err && err.type === 'StripeCardError') {
      const d = explainDecline(err);
      // Tell the client themselves, rather than leaving Heshy to write that message. He asked
      // for this to be automatic; chasing payments is the part of the job he doesn't do.
      const emailed = await notifyClientOfDecline(req.body?.bookingId, d, err);
      return res.status(402).json({
        error: d.message, reason: d.code, next: d.next, retryable: d.retryable, clientEmailed: emailed
      });
    }
    res.status(500).json({ error: 'Something went wrong processing the charge. Please try again.' });
  }
}
