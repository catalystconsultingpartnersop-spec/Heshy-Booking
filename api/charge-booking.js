import { kv } from '@vercel/kv';
import { mutate, SKIP_WRITE } from './_lib/store.js';
import { verifyAdminToken } from './_lib/auth.js';
import { sendEmail, receiptEmail } from './_lib/email.js';
import { logError } from './_lib/errorlog.js';
import { stripe, defaultCardFor } from './_lib/stripecustomer.js';
import { computeCharge } from './_lib/billing.js';

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
      return res.status(402).json({ error: d.message, reason: d.code, next: d.next, retryable: d.retryable });
    }
    res.status(500).json({ error: 'Something went wrong processing the charge. Please try again.' });
  }
}
