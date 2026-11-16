// Limits on what anyone can do to the public endpoints without being asked who they are.
//
// Until now the booking page's endpoints were open and unbounded. Anyone could create Stripe
// customers and SetupIntents in a loop, probe coupon codes, pull Heshy's free/busy for the next
// six months, or submit booking attempts as fast as they liked — running up quota and cost and
// filling the Stripe dashboard with junk. Separately, six wrong password guesses locked the only
// administrator out, and an anonymous caller could repeat that every fifteen minutes.
//
// None of this is about a determined attacker; it is about making ordinary abuse boring and
// keeping one anonymous caller from affecting Heshy's own access.

import { kv } from '@vercel/kv';

/** Best guess at who is calling. Spoofable, which is why limits here are generous, not strict. */
export function callerIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  const first = typeof fwd === 'string' ? fwd.split(',')[0].trim() : null;
  return first || req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

/**
 * Count one request against a bucket.
 * @returns {Promise<{allowed:boolean, remaining:number, retryAfter:number}>}
 * Never throws and never blocks on failure: if the counter itself is broken, requests go
 * through rather than the booking page going down.
 */
export async function hit(bucket, id, max, windowSeconds) {
  const key = `rl:${bucket}:${id}`;
  try {
    const current = Number(await kv.incr(key)) || 1;
    if (current === 1) await kv.expire(key, windowSeconds);
    return {
      allowed: current <= max,
      remaining: Math.max(0, max - current),
      retryAfter: windowSeconds
    };
  } catch (e) {
    console.error('Rate limit check failed open:', e);
    return { allowed: true, remaining: max, retryAfter: 0 };
  }
}

/**
 * Guard a handler. Returns true when the request should stop, having already replied.
 *
 *   if (await limited(req, res, 'create-booking', 20, 3600)) return;
 */
export async function limited(req, res, bucket, max, windowSeconds, message) {
  const r = await hit(bucket, callerIp(req), max, windowSeconds);
  if (r.allowed) return false;
  res.status(429).json({
    error: message || "That's a lot of requests in a short time. Please wait a few minutes and try again."
  });
  return true;
}

// --- size limits ---------------------------------------------------------------------------
// Names, phones, intake answers, notes and uploads had no server-side bound at all. The browser
// capped them; anything not using the browser did not.

export const FIELD_LIMITS = {
  name: 200,
  email: 320,
  phone: 40,
  couponCode: 60,
  intakeAnswer: 2000,
  intakeAnswers: 50
};

export const MAX_PDF_BYTES = 15 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/** Rejects fields that are too long, before they reach storage. Returns an error string or null. */
export function checkBookingFields({ name, email, phone, couponCode, intakeAnswers }) {
  if (String(name || '').length > FIELD_LIMITS.name) return 'That name is too long.';
  if (String(email || '').length > FIELD_LIMITS.email) return 'That email address is too long.';
  if (String(phone || '').length > FIELD_LIMITS.phone) return 'That phone number is too long.';
  if (String(couponCode || '').length > FIELD_LIMITS.couponCode) return 'That coupon code is too long.';
  if (intakeAnswers != null) {
    if (!Array.isArray(intakeAnswers)) return 'Those answers were not in the expected form.';
    if (intakeAnswers.length > FIELD_LIMITS.intakeAnswers) return 'Too many answers were submitted.';
    if (intakeAnswers.some(a => String(a ?? '').length > FIELD_LIMITS.intakeAnswer)) return 'One of those answers is too long.';
  }
  return null;
}

/**
 * Checks a data: URL actually carries what it claims, before anything is decoded into memory.
 * A PDF upload used to be trusted on the strength of its declared type alone.
 */
export function checkDataUrl(dataUrl, { expect, maxBytes }) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return 'That file was not in the expected form.';
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return 'That file was not in the expected form.';
  const header = dataUrl.slice(5, comma);
  if (!header.includes('base64')) return 'That file was not in the expected form.';

  // Decoded size, worked out from the encoded length — no need to allocate it to find out.
  const encoded = dataUrl.length - comma - 1;
  const padding = dataUrl.endsWith('==') ? 2 : dataUrl.endsWith('=') ? 1 : 0;
  const bytes = Math.floor(encoded * 3 / 4) - padding;
  if (bytes > maxBytes) return `That file is too large (${Math.round(bytes / 1024 / 1024)}MB). The limit is ${Math.round(maxBytes / 1024 / 1024)}MB.`;

  if (expect === 'pdf') {
    // A real PDF starts "%PDF-", which is "JVBERi" once base64-encoded. Claiming the type is
    // not the same as being it.
    const start = dataUrl.slice(comma + 1, comma + 9);
    if (!start.startsWith('JVBERi')) return "That file doesn't look like a PDF.";
  }
  return null;
}
