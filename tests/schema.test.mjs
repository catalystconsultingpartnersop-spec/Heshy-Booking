// What Manage is allowed to save. Each of these is something that used to be written straight
// into the live record without a word.
import { validateAppData, isRealDate } from '../api/_lib/schema.js';

let pass = 0, fail = 0; const failures = [];
function check(name, cond, detail='') { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n    ' + detail : '')); } }
const ok = (name, input) => { const r = validateAppData(input); check(name, r.ok === true, r.error); return r; };
const rejects = (name, input, match) => {
  const r = validateAppData(input);
  check(name, r.ok === false && (!match || match.test(r.error)), r.ok ? 'accepted it' : r.error);
  return r;
};

const base = () => ({
  clients: [{ id: 'c1', name: 'Rivka Stern', email: 'r@example.com', phone: '3475550101' }],
  bookings: [{ id: 'b1', date: '2026-12-01', time: '11:00', durationMin: 60, type: 'virtual' }],
  availability: { virtual: [{ id: 'r1', days: [1,2,3], start: '09:00', end: '17:00' }], 'in-person': [] },
  overrides: [], blockedDates: [],
  settings: { hourlyRate: 500, durationOptions: [60, 120], minLeadHours: 12, billingMode: 'minimum',
              coupons: [{ code: 'FRIEND', discountType: 'percent', discountValue: 50, maxUses: 3 }] }
});

// --- a normal save goes through ---------------------------------------------------------------
ok('a normal record saves', base());
ok('an empty but well-formed record saves', { clients: [], bookings: [] });
ok('unknown fields are left alone', { ...base(), someNewFeature: { enabled: true } });
check('...and survive validation', validateAppData({ ...base(), someNewFeature: 1 }).data.someNewFeature === 1);

// --- the catastrophic ones ----------------------------------------------------------------------
rejects('a save that is not an object at all', 'wipe', /did not contain a record/);
rejects('a save that is null', null);
rejects('clients replaced by something that is not a list', { ...base(), clients: 'gone' }, /has to be a list/);
rejects('bookings replaced by something that is not a list', { ...base(), bookings: {} }, /has to be a list/);
rejects('a save that would remove every client',
        { ...base(), clients: [], __hadClients: 14 }, /every client/i);
ok('...but an account that genuinely has no clients is fine', { ...base(), clients: [], __hadClients: 0 });

// --- availability: the thing that breaks the booking page --------------------------------------
rejects('an availability rule with a nonsense time',
        { ...base(), availability: { virtual: [{ id: 'r', days: [1], start: '9am', end: '5pm' }] } }, /invalid time/i);
rejects('an availability rule that ends before it starts',
        { ...base(), availability: { virtual: [{ id: 'r', days: [1], start: '17:00', end: '09:00' }] } }, /ends before it starts/i);
rejects('an availability rule with an impossible weekday',
        { ...base(), availability: { virtual: [{ id: 'r', days: [9], start: '09:00', end: '17:00' }] } }, /days of the week/i);
rejects('an availability rule with a 25th hour',
        { ...base(), availability: { virtual: [{ id: 'r', days: [1], start: '25:00', end: '26:00' }] } }, /invalid time/i);
ok('midnight is a valid time', { ...base(), availability: { virtual: [{ id: 'r', days: [1], start: '00:00', end: '23:59' }] } });

// --- dates ----------------------------------------------------------------------------------------
check('a real date passes', isRealDate('2026-02-28'));
check('a leap day in a leap year passes', isRealDate('2028-02-29'));
check('a leap day in a non-leap year fails', !isRealDate('2027-02-29'));
check('the 31st of February fails', !isRealDate('2026-02-31'));
check('the 13th month fails', !isRealDate('2026-13-01'));
check('a non-date fails', !isRealDate('tomorrow') && !isRealDate('') && !isRealDate(null));
rejects('a session dated the 31st of February',
        { ...base(), bookings: [{ id: 'b', date: '2026-02-31', time: '11:00', durationMin: 60 }] }, /invalid date/i);
rejects('a one-off date that is not a date',
        { ...base(), overrides: [{ id: 'o', date: 'soon', start: '09:00', end: '10:00' }] }, /invalid date/i);

// --- money ------------------------------------------------------------------------------------------
rejects('a negative hourly rate', { ...base(), settings: { hourlyRate: -100 } }, /zero or more/i);
rejects('an absurd hourly rate', { ...base(), settings: { hourlyRate: 9999999 } }, /mistake/i);
rejects('an hourly rate that is text', { ...base(), settings: { hourlyRate: 'five hundred' } });
ok('a zero rate is allowed', { ...base(), settings: { hourlyRate: 0 } });
check('a numeric string rate is coerced', validateAppData({ ...base(), settings: { hourlyRate: '450' } }).data.settings.hourlyRate === 450);

rejects('a session with a negative amount',
        { ...base(), bookings: [{ id: 'b', date: '2026-12-01', time: '11:00', durationMin: 60, amount: -50 }] }, /negative/i);
rejects('a session lasting a week',
        { ...base(), bookings: [{ id: 'b', date: '2026-12-01', time: '11:00', durationMin: 100000 }] }, /invalid length/i);
rejects('a session with no length', { ...base(), bookings: [{ id: 'b', date: '2026-12-01', time: '11:00' }] }, /invalid length/i);

// --- coupons: these silently cost money -----------------------------------------------------------------
rejects('a 400% discount',
        { ...base(), settings: { coupons: [{ code: 'X', discountType: 'percent', discountValue: 400 }] } }, /0–100/);
rejects('a negative percentage',
        { ...base(), settings: { coupons: [{ code: 'X', discountType: 'percent', discountValue: -20 }] } }, /0–100/);
rejects('a negative dollar discount',
        { ...base(), settings: { coupons: [{ code: 'X', discountType: 'fixed', discountValue: -250 }] } }, /negative/i);
rejects('a coupon with no code',
        { ...base(), settings: { coupons: [{ discountType: 'free' }] } }, /no code/i);
rejects('two coupons with the same code',
        { ...base(), settings: { coupons: [{ code: 'A', discountType: 'free' }, { code: 'a', discountType: 'free' }] } }, /two coupons/i);
rejects('a coupon with an unknown discount type',
        { ...base(), settings: { coupons: [{ code: 'X', discountType: 'buy-one-get-one' }] } }, /unknown discount type/i);
rejects('a coupon with a fractional usage limit',
        { ...base(), settings: { coupons: [{ code: 'X', discountType: 'free', maxUses: 2.5 }] } }, /usage limit/i);
const couponOk = validateAppData({ ...base(), settings: { coupons: [{ code: ' friend ', discountType: 'percent', discountValue: '50' }] } });
check('a coupon code is tidied to upper case', couponOk.data.settings.coupons[0].code === 'FRIEND', couponOk.data?.settings?.coupons?.[0]?.code);
check('a numeric-string discount is coerced', couponOk.data.settings.coupons[0].discountValue === 50);

// --- other settings -------------------------------------------------------------------------------------
rejects('an unknown billing mode', { ...base(), settings: { billingMode: 'whatever' } }, /actual.*minimum/i);
rejects('a negative notice period', { ...base(), settings: { minLeadHours: -5 } }, /between 0/i);
rejects('a session length of zero', { ...base(), settings: { durationOptions: [0] } }, /positive numbers/i);
rejects('a negative session length', { ...base(), settings: { durationOptions: [-60] } }, /positive numbers/i);

// --- runaway text is trimmed, not rejected -----------------------------------------------------------------
const huge = 'x'.repeat(500000);
const trimmed = validateAppData({ ...base(), clients: [{ id: 'c', name: huge, email: huge, phone: huge, notes: huge }] });
check('a gigantic name is trimmed rather than stored whole', trimmed.ok && trimmed.data.clients[0].name.length === 200);
check('a gigantic email is trimmed', trimmed.data.clients[0].email.length === 320);
check('a gigantic phone number is trimmed', trimmed.data.clients[0].phone.length === 40);
check('gigantic notes are trimmed', trimmed.data.clients[0].notes.length === 10000);

rejects('an implausible number of clients',
        { ...base(), clients: Array.from({ length: 20001 }, (_, i) => ({ id: 'c' + i })) }, /implausible/i);

// --- malformed records --------------------------------------------------------------------------------------
rejects('a client that is a string', { ...base(), clients: ['nope'] }, /malformed/i);
rejects('a client with no id', { ...base(), clients: [{ name: 'x' }] }, /no id/i);
rejects('a session with no id', { ...base(), bookings: [{ date: '2026-12-01', time: '11:00', durationMin: 60 }] }, /no id/i);

// The marker used to detect a wipe must never be written into the record.
check('the internal wipe-check marker is never stored',
      !('__hadClients' in validateAppData({ ...base(), __hadClients: 5 }).data));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILURES:\n' + failures.map(f => '  ' + f).join('\n')); process.exit(1); }
