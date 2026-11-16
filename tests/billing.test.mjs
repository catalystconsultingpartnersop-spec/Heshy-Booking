// Money. Every one of these is a case that previously charged the wrong amount.
import { computeCharge, billableMinutes, applyDiscount } from '../api/_lib/billing.js';

let pass = 0, fail = 0; const failures = [];
function check(name, cond, detail='') { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n    ' + detail : '')); } }
const eq = (name, got, want) => check(name, got === want, `got ${got}, wanted ${want}`);

const RATE = { hourlyRate: 500 };
const MIN = { hourlyRate: 500, billingMode: 'minimum' };
const ACT = { hourlyRate: 500, billingMode: 'actual' };
const bk = o => ({ durationMin: 60, actualMinutes: null, comped: false, couponDiscount: null, ...o });

// --- the undercharge bug --------------------------------------------------------------------
eq('minimum mode bills the overrun, not the booked length',
   billableMinutes(bk({ durationMin: 60, actualMinutes: 90 }), MIN), 90);
eq('minimum mode still bills the booked length when it ran short',
   billableMinutes(bk({ durationMin: 60, actualMinutes: 35 }), MIN), 60);
eq('a 90-minute session booked for 60 is $750, not $500',
   computeCharge(bk({ durationMin: 60, actualMinutes: 90 }), MIN).cents, 75000);
eq('actual mode bills what it ran',
   billableMinutes(bk({ durationMin: 60, actualMinutes: 35 }), ACT), 35);
eq('no recorded time falls back to the booked length',
   billableMinutes(bk({ durationMin: 120, actualMinutes: null }), MIN), 120);
// A timer that never ran, or was stopped by accident, must not zero the bill.
eq('0 minutes recorded means "nothing recorded", so it bills the booked length',
   billableMinutes(bk({ durationMin: 60, actualMinutes: 0 }), ACT), 60);
eq('...in minimum mode too',
   billableMinutes(bk({ durationMin: 60, actualMinutes: 0 }), MIN), 60);
eq('a nonsense recorded value also falls back to the booked length',
   billableMinutes(bk({ durationMin: 60, actualMinutes: NaN }), ACT), 60);

// --- comped ---------------------------------------------------------------------------------
const comped = computeCharge(bk({ comped: true, actualMinutes: 180 }), MIN);
eq('a comped session costs nothing however long it ran', comped.cents, 0);
check('a comped session is flagged as such', comped.comped === true);

// --- coupons --------------------------------------------------------------------------------
eq('percent off', computeCharge(bk({ actualMinutes: 60, couponDiscount: { type: 'percent', value: 50 } }), ACT).cents, 25000);
eq('fixed amount off (the type coupons are actually saved with)',
   computeCharge(bk({ actualMinutes: 60, couponDiscount: { type: 'fixed', value: 200 } }), ACT).cents, 30000);
eq('legacy "amount" spelling works too',
   computeCharge(bk({ actualMinutes: 60, couponDiscount: { type: 'amount', value: 200 } }), ACT).cents, 30000);
eq('a discount bigger than the session never goes negative',
   computeCharge(bk({ actualMinutes: 30, couponDiscount: { type: 'fixed', value: 9999 } }), ACT).cents, 0);
eq('over-100 percent is capped, not inverted', applyDiscount(50000, { type: 'percent', value: 250 }), 0);
eq('a negative discount is ignored rather than adding money', applyDiscount(50000, { type: 'percent', value: -50 }), 50000);
eq('a nonsense discount value is ignored', applyDiscount(50000, { type: 'fixed', value: NaN }), 50000);
eq('no coupon leaves the amount alone', applyDiscount(50000, null), 50000);

// the combination that used to be wrong twice over: ran long AND discounted
eq('ran long and discounted: bills the overrun, then the discount',
   computeCharge(bk({ durationMin: 60, actualMinutes: 90, couponDiscount: { type: 'percent', value: 50 } }), MIN).cents, 37500);

// --- rate ------------------------------------------------------------------------------------
eq('uses the configured hourly rate',
   computeCharge(bk({ actualMinutes: 60 }), { hourlyRate: 250, billingMode: 'actual' }).cents, 25000);
eq('falls back to 500 when no rate is set', computeCharge(bk({ actualMinutes: 60 }), {}).cents, 50000);
eq('a zero rate is honoured, not treated as missing',
   computeCharge(bk({ actualMinutes: 60 }), { hourlyRate: 0, billingMode: 'actual' }).cents, 0);
eq('15-minute check-in at $500', computeCharge(bk({ durationMin: 15, actualMinutes: 15 }), ACT).cents, 12500);
// Bills from the rounded hours Manage displays, so the amount always matches what's on screen.
eq('50 min reads as 0.83 hrs and bills $415', computeCharge(bk({ durationMin: 50, actualMinutes: 50 }), ACT).cents, 41500);
eq('8 min reads as 0.13 hrs and bills $65', computeCharge(bk({ durationMin: 15, actualMinutes: 8 }), ACT).cents, 6500);

// --- the discounted flag drives what Manage shows ---------------------------------------------
check('a plain session is not marked discounted', computeCharge(bk({ actualMinutes: 60 }), ACT).discounted === false);
check('a discounted session is marked', computeCharge(bk({ actualMinutes: 60, couponDiscount: { type: 'percent', value: 10 } }), ACT).discounted === true);
eq('fullCents reports the undiscounted price for the "was → now" note',
   computeCharge(bk({ actualMinutes: 60, couponDiscount: { type: 'percent', value: 50 } }), ACT).fullCents, 50000);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILURES:\n' + failures.map(f => '  ' + f).join('\n')); process.exit(1); }
