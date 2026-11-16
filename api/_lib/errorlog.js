// Append-only record of anything that failed server-side.
//
// Why: when a client reports "Something went wrong. Please try again." the only evidence used
// to be Vercel's runtime logs, which are short-lived and awkward to reach. This keeps the last
// 200 failures in the app's own storage, readable from Manage, so a failure can be diagnosed
// after the fact instead of needing to be reproduced.
//
// Kept in its own KV list rather than inside the app-data blob so a concurrent write can't
// clobber it, and so a failure *during* a data write still gets recorded.

import { kv } from '@vercel/kv';

const KEY = 'error-log';
const MAX_ENTRIES = 200;

// Values that must never be written here, even though this log is admin-only.
const SENSITIVE = /^(card|cvc|number|password|token|secret|clientsecret|authorization)$/i;

function safeContext(ctx) {
  if (!ctx || typeof ctx !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (SENSITIVE.test(k)) continue;
    if (v == null) continue;
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    out[k] = s.length > 200 ? s.slice(0, 200) + '…' : s;
  }
  return out;
}

/**
 * Record a server-side failure. Never throws: a logging problem must not turn a handled
 * error into a second failure.
 * @param {string} where  which endpoint/action failed, e.g. 'create-booking'
 * @param {unknown} err   the thrown value
 * @param {object} context  small, non-sensitive details that help identify the request
 */
export async function logError(where, err, context = {}) {
  try {
    const entry = {
      at: new Date().toISOString(),
      where,
      message: (err && err.message) ? String(err.message).slice(0, 400) : String(err).slice(0, 400),
      type: err && err.name ? err.name : undefined,
      // Stripe and other SDKs hang useful codes off the error.
      code: err && (err.code || err.statusCode) ? String(err.code || err.statusCode) : undefined,
      stack: err && err.stack ? String(err.stack).split('\n').slice(1, 4).map(l => l.trim()).join(' | ').slice(0, 400) : undefined,
      context: safeContext(context)
    };
    await kv.lpush(KEY, JSON.stringify(entry));
    await kv.ltrim(KEY, 0, MAX_ENTRIES - 1);
  } catch (e) {
    console.error('Could not write to the error log:', e);
  }
}

export async function readErrors(limit = 60) {
  try {
    const raw = await kv.lrange(KEY, 0, Math.max(0, limit - 1));
    return (raw || []).map(r => {
      try { return typeof r === 'string' ? JSON.parse(r) : r; } catch (e) { return null; }
    }).filter(Boolean);
  } catch (e) {
    console.error('Could not read the error log:', e);
    return [];
  }
}

export async function clearErrors() {
  try { await kv.del(KEY); return true; } catch (e) { return false; }
}
