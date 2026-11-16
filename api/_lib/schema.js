// What Manage is allowed to save.
//
// The POST handler used to accept any JSON object as the complete business record and write it
// straight over everything. A stale tab, a malformed request or a browser bug could blank the
// availability rules, drop every client, or store a 400% discount — and the first anyone would
// know is when the booking page stopped working.
//
// This is deliberately a gatekeeper, not a transformer: it rejects clearly broken input and
// bounds the values that can do damage, while leaving fields it doesn't know about alone, so
// adding a feature doesn't mean editing this file before it can be saved.

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const isArr = Array.isArray;

export const LIMITS = {
  name: 200,
  email: 320,
  phone: 40,
  text: 2000,        // notes, summaries, intake answers, addresses
  coupons: 500,
  clients: 20000,
  bookings: 50000,
  rules: 500,
  overrides: 2000
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A real calendar date, not just four digits and two hyphens — rejects 2026-02-31. */
export function isRealDate(v) {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}
export const isTime = v => typeof v === 'string' && TIME_RE.test(v);

function str(v, max) {
  if (v == null) return '';
  return String(v).slice(0, max);
}

/**
 * Checks an incoming record. Returns { ok: true, data } with values trimmed to sane bounds, or
 * { ok: false, error } naming the first thing that is wrong, in words that mean something.
 */
export function validateAppData(input) {
  if (!isObj(input)) return { ok: false, error: 'That save did not contain a record at all.' };

  const d = { ...input };

  // --- the collections that must exist -----------------------------------------------------
  for (const key of ['clients', 'bookings']) {
    if (d[key] == null) d[key] = [];
    if (!isArr(d[key])) return { ok: false, error: `"${key}" has to be a list.` };
  }
  if (d.clients.length > LIMITS.clients) return { ok: false, error: 'That save holds an implausible number of clients.' };
  if (d.bookings.length > LIMITS.bookings) return { ok: false, error: 'That save holds an implausible number of sessions.' };

  // Losing every client or every booking in one save is never a thing anyone means to do.
  // It is the exact shape of the bug this guards against, so it is refused outright.
  if (d.clients.length === 0 && (input.__hadClients || 0) > 0) {
    return { ok: false, error: 'That save would have removed every client. Refusing it — reload Manage and try again.' };
  }

  // --- availability -------------------------------------------------------------------------
  if (d.availability != null) {
    if (!isObj(d.availability)) return { ok: false, error: 'The availability section is malformed.' };
    for (const kind of ['virtual', 'in-person']) {
      const rules = d.availability[kind];
      if (rules == null) continue;
      if (!isArr(rules)) return { ok: false, error: `Availability for "${kind}" has to be a list.` };
      if (rules.length > LIMITS.rules) return { ok: false, error: 'Too many availability rules.' };
      for (const r of rules) {
        if (!isObj(r)) return { ok: false, error: 'An availability rule is malformed.' };
        if (!isTime(r.start) || !isTime(r.end)) {
          return { ok: false, error: `An availability rule has an invalid time (${str(r.start, 20)}–${str(r.end, 20)}). Use 24-hour times like 09:30.` };
        }
        if (r.start >= r.end) {
          return { ok: false, error: `An availability rule ends before it starts (${r.start}–${r.end}).` };
        }
        if (!isArr(r.days) || r.days.some(x => !Number.isInteger(x) || x < 0 || x > 6)) {
          return { ok: false, error: 'An availability rule has invalid days of the week.' };
        }
        r.generalArea = str(r.generalArea, LIMITS.text);
        r.address = str(r.address, LIMITS.text);
      }
    }
  }

  // --- one-off dates ------------------------------------------------------------------------
  for (const key of ['overrides', 'blockedDates']) {
    if (d[key] == null) continue;
    if (!isArr(d[key])) return { ok: false, error: `"${key}" has to be a list.` };
    if (d[key].length > LIMITS.overrides) return { ok: false, error: `Too many entries in ${key}.` };
    for (const o of d[key]) {
      if (!isObj(o)) return { ok: false, error: `An entry in ${key} is malformed.` };
      if (!isRealDate(o.date)) return { ok: false, error: `An entry in ${key} has an invalid date (${str(o.date, 20)}).` };
      if (key === 'overrides') {
        if (!isTime(o.start) || !isTime(o.end)) return { ok: false, error: `A one-off date has an invalid time (${str(o.start, 20)}–${str(o.end, 20)}).` };
        if (o.start >= o.end) return { ok: false, error: `A one-off date ends before it starts (${o.start}–${o.end}).` };
      }
    }
  }

  // --- settings ------------------------------------------------------------------------------
  if (d.settings != null) {
    if (!isObj(d.settings)) return { ok: false, error: 'The settings section is malformed.' };
    const s = d.settings;

    if (s.hourlyRate != null) {
      const rate = Number(s.hourlyRate);
      if (!isFinite(rate) || rate < 0) return { ok: false, error: 'The hourly rate has to be a number of zero or more.' };
      if (rate > 100000) return { ok: false, error: 'That hourly rate looks like a mistake.' };
      s.hourlyRate = rate;
    }
    if (s.durationOptions != null) {
      if (!isArr(s.durationOptions) || s.durationOptions.some(x => !Number.isFinite(Number(x)) || Number(x) <= 0 || Number(x) > 1440)) {
        return { ok: false, error: 'Session lengths have to be positive numbers of minutes.' };
      }
      s.durationOptions = s.durationOptions.map(Number);
    }
    for (const [key, label, max] of [['minLeadHours', 'notice period', 8760], ['clientCancelCutoffHours', 'cancellation cutoff', 8760]]) {
      if (s[key] == null) continue;
      const n = Number(s[key]);
      if (!isFinite(n) || n < 0 || n > max) return { ok: false, error: `The ${label} has to be between 0 and ${max} hours.` };
      s[key] = n;
    }
    if (s.billingMode != null && !['actual', 'minimum'].includes(s.billingMode)) {
      return { ok: false, error: 'Billing mode has to be either "actual" or "minimum".' };
    }
    if (s.intakeQuestions != null) {
      if (!isArr(s.intakeQuestions)) return { ok: false, error: 'Intake questions have to be a list.' };
      s.intakeQuestions = s.intakeQuestions.slice(0, 50).map(q => str(q, 500));
    }
    s.location = str(s.location, LIMITS.text);
    s.meetLink = str(s.meetLink, 500);

    // --- coupons: the values that silently cost money if they are wrong --------------------
    if (s.coupons != null) {
      if (!isArr(s.coupons)) return { ok: false, error: 'Coupons have to be a list.' };
      if (s.coupons.length > LIMITS.coupons) return { ok: false, error: 'Too many coupons.' };
      const seen = new Set();
      for (const c of s.coupons) {
        if (!isObj(c)) return { ok: false, error: 'A coupon is malformed.' };
        c.code = str(c.code, 60).trim().toUpperCase();
        if (!c.code) return { ok: false, error: 'A coupon has no code.' };
        if (seen.has(c.code)) return { ok: false, error: `There are two coupons with the code ${c.code}.` };
        seen.add(c.code);
        c.description = str(c.description, 300);

        if (c.discountType != null && !['free', 'percent', 'fixed'].includes(c.discountType)) {
          return { ok: false, error: `Coupon ${c.code} has an unknown discount type.` };
        }
        if (c.discountType === 'percent') {
          const v = Number(c.discountValue);
          if (!isFinite(v) || v < 0 || v > 100) return { ok: false, error: `Coupon ${c.code} has a percentage outside 0–100.` };
          c.discountValue = v;
        } else if (c.discountType === 'fixed') {
          const v = Number(c.discountValue);
          if (!isFinite(v) || v < 0) return { ok: false, error: `Coupon ${c.code} has a negative or invalid amount.` };
          c.discountValue = v;
        }
        if (c.maxUses != null && c.maxUses !== '') {
          const m = Number(c.maxUses);
          if (!Number.isInteger(m) || m < 0) return { ok: false, error: `Coupon ${c.code} has an invalid usage limit.` };
          c.maxUses = m;
        }
      }
    }
  }

  // --- clients and bookings: bound the free text, check the dates -----------------------------
  for (const c of d.clients) {
    if (!isObj(c)) return { ok: false, error: 'A client record is malformed.' };
    if (!c.id) return { ok: false, error: 'A client record has no id.' };
    c.name = str(c.name, LIMITS.name);
    c.email = str(c.email, LIMITS.email);
    c.phone = str(c.phone, LIMITS.phone);
    if (c.notes != null) c.notes = str(c.notes, LIMITS.text * 5);
  }
  for (const b of d.bookings) {
    if (!isObj(b)) return { ok: false, error: 'A session record is malformed.' };
    if (!b.id) return { ok: false, error: 'A session record has no id.' };
    if (!isRealDate(b.date)) return { ok: false, error: `A session has an invalid date (${str(b.date, 20)}).` };
    if (!isTime(b.time)) return { ok: false, error: `A session has an invalid time (${str(b.time, 20)}).` };
    const dur = Number(b.durationMin);
    if (!isFinite(dur) || dur <= 0 || dur > 1440) return { ok: false, error: `A session has an invalid length (${str(b.durationMin, 20)} minutes).` };
    if (b.amount != null) {
      const amt = Number(b.amount);
      if (!isFinite(amt) || amt < 0) return { ok: false, error: 'A session has a negative or invalid amount.' };
    }
    if (b.actualMinutes != null) {
      const am = Number(b.actualMinutes);
      if (!isFinite(am) || am < 0 || am > 1440) return { ok: false, error: 'A session has an invalid recorded time.' };
    }
    b.clientName = str(b.clientName, LIMITS.name);
    b.clientEmail = str(b.clientEmail, LIMITS.email);
    b.clientPhone = str(b.clientPhone, LIMITS.phone);
  }

  delete d.__hadClients;
  return { ok: true, data: d };
}
