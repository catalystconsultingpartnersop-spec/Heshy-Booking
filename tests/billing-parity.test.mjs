// Manage shows a figure; the server charges one. If they disagree, Heshy bills an amount he
// never saw. This lifts the real arithmetic out of public/index.html and checks it against
// api/_lib/billing.js across every combination that matters.
import { readFileSync } from 'node:fs';
import { computeCharge } from '../api/_lib/billing.js';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

// Pull the exact lines Manage uses, so this test breaks if either side is edited alone.
function must(re, label) {
  const m = html.match(re);
  if (!m) { console.error(`Could not find ${label} in index.html — the charge UI changed shape.`); process.exit(1); }
  return m[0];
}
const minsLine = must(/const minsForBilling = basis==='minimum' \? [^;]+;/, 'the billable-minutes line');
const pctLine  = must(/defaultAmt = Math\.round\(baseAmt\*\(1-Math\.min\(100,b\.couponDiscount\.value\)\/100\)\*100\)\/100;/, 'the percent-discount line');
const fixLine  = must(/defaultAmt = Math\.max\(0, Math\.round\(\(baseAmt-b\.couponDiscount\.value\)\*100\)\/100\);/, 'the fixed-discount line');

// Rebuild the browser's calculation from those exact lines.
const browserSrc = `
export function browserAmount(b, settings, basis){
  const actualMins = b.actualMinutes || b.durationMin;
  ${minsLine}
  const hours = Math.round((minsForBilling/60)*100)/100;
  const rate = settings.hourlyRate || 500;
  const baseAmt = Math.round(hours*rate*100)/100;
  let defaultAmt = baseAmt;
  if(b.couponDiscount && b.couponDiscount.type==='percent'){
    ${pctLine}
  } else if(b.couponDiscount && (b.couponDiscount.type==='fixed'||b.couponDiscount.type==='amount')){
    ${fixLine}
  }
  return defaultAmt;
}`;
const { browserAmount } = await import('data:text/javascript;base64,' + Buffer.from(browserSrc).toString('base64'));

let pass = 0, fail = 0; const failures = [];

const DURATIONS = [15, 45, 60, 120];
const ACTUALS = [null, 0, 8, 35, 59, 60, 61, 90, 125, 240];
const RATES = [250, 500, 1000];
const COUPONS = [null,
  { type: 'percent', value: 10 }, { type: 'percent', value: 50 }, { type: 'percent', value: 100 },
  { type: 'fixed', value: 50 }, { type: 'fixed', value: 500 }, { type: 'amount', value: 125 }];

let compared = 0;
for (const durationMin of DURATIONS)
  for (const actualMinutes of ACTUALS)
    for (const hourlyRate of RATES)
      for (const couponDiscount of COUPONS)
        for (const mode of ['actual', 'minimum']) {
          const booking = { durationMin, actualMinutes, comped: false, couponDiscount };
          const settings = { hourlyRate, billingMode: mode };
          // Manage's basis toggle defaults to the configured billing mode.
          const shown = browserAmount(booking, settings, mode);
          const charged = computeCharge(booking, settings).cents / 100;
          compared++;
          if (Math.abs(shown - charged) < 0.005) pass++;
          else {
            fail++;
            if (failures.length < 6) failures.push(
              `${durationMin}min booked, ${actualMinutes} actual, $${hourlyRate}/hr, ${mode}, coupon ${JSON.stringify(couponDiscount)}\n` +
              `    Manage shows $${shown}, server charges $${charged}`);
          }
        }
console.log(`compared ${compared} booking/settings combinations`);

// A comped booking must never reach the charge controls at all; the server returns zero
// regardless of what the page might have computed.
const compedZero = computeCharge({ durationMin: 60, actualMinutes: 240, comped: true, couponDiscount: null }, { hourlyRate: 500, billingMode: 'minimum' }).cents;
if (compedZero === 0) pass++; else { fail++; failures.push(`comped session priced at ${compedZero} cents`); }

// And the page must genuinely branch on `comped` before rendering a Charge button.
if (/if\(b\.comped\)\{[\s\S]{0,900}?Complete at no charge/.test(html)) pass++;
else { fail++; failures.push('Manage no longer shows a no-charge path for comped sessions'); }

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILURES:\n' + failures.map(f => '  ' + f).join('\n')); process.exit(1); }
