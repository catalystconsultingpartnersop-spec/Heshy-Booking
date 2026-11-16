// What a session actually costs.
//
// This used to live only in the browser, which meant Manage decided the amount and the charge
// endpoint simply believed it. Two things went wrong because of that. In "minimum" mode a
// session that ran long still billed the reserved length, even though clients are told longer
// sessions bill actual time. And coupons and complimentary status only ever adjusted the
// suggested figure on screen — editing the hours recalculated at full price and quietly dropped
// the discount, and a free session still showed normal charge controls.
//
// Now the server works the amount out from what was saved with the booking, and the browser
// shows the same calculation rather than owning it.

export const DEFAULT_RATE = 500;

/**
 * Minutes to bill.
 *  - "minimum" (Full booked length): the reserved time is a floor, so a session that runs over
 *    bills what it actually ran. This is the bug fix — it used to always return the booked length.
 *  - "actual": what it ran, falling back to the booked length when nothing was recorded.
 */
export function billableMinutes(booking, settings = {}) {
  const booked = Number(booking.durationMin) || 60;
  // Zero counts as "nothing was recorded", not as a free session. A timer that never ran, or
  // that was started and stopped by accident, must not silently zero the bill — it falls back
  // to the booked length, which Heshy can see and adjust. Manage has always behaved this way.
  const raw = Number(booking.actualMinutes);
  const actual = (booking.actualMinutes != null && isFinite(raw) && raw > 0) ? raw : null;
  if (actual == null) return booked;
  return settings.billingMode === 'minimum' ? Math.max(booked, actual) : actual;
}

/** Applies a coupon saved on the booking. Percent and fixed-amount discounts never go below zero. */
export function applyDiscount(cents, couponDiscount) {
  if (!couponDiscount || !couponDiscount.type) return cents;
  const value = Number(couponDiscount.value);
  if (!isFinite(value) || value < 0) return cents;
  if (couponDiscount.type === 'percent') {
    const pct = Math.min(100, value);
    return Math.max(0, Math.round(cents * (1 - pct / 100)));
  }
  // Coupons are saved with type 'fixed'; 'amount' is accepted too in case an older record used it.
  if (couponDiscount.type === 'fixed' || couponDiscount.type === 'amount') {
    return Math.max(0, cents - Math.round(value * 100));
  }
  return cents;
}

/**
 * The amount to charge, in cents, derived entirely from the booking's own saved terms.
 * `comped` means no card is touched at all — the session is completed at zero.
 */
export function computeCharge(booking, settings = {}) {
  const rate = (settings.hourlyRate != null && Number(settings.hourlyRate) >= 0)
    ? Number(settings.hourlyRate)
    : DEFAULT_RATE;
  const minutes = billableMinutes(booking, settings);
  // Bill from hours rounded to two decimals, not from raw minutes. Manage shows an editable
  // "Hours to bill" box holding that rounded figure, so billing from anything else would charge
  // an amount that doesn't match the hours on screen (8 minutes reads as 0.13 hrs = $65, not
  // $66.67). The number Heshy sees is the number he is charging.
  const hours = Math.round((minutes / 60) * 100) / 100;
  const fullCents = Math.round(hours * rate * 100);

  if (booking.comped) {
    return { cents: 0, minutes, fullCents, comped: true, discounted: false, rate };
  }
  const cents = applyDiscount(fullCents, booking.couponDiscount);
  return { cents, minutes, fullCents, comped: false, discounted: cents !== fullCents, rate };
}
