import { kv } from '@vercel/kv';
import { randomBytes, timingSafeEqual } from 'crypto';

export async function verifyAdminToken(req) {
  const token = req.headers['x-admin-token'];
  if (!token) return false;
  const valid = await kv.get('admin-session:' + token);
  return !!valid;
}

// A separate, read-only credential so Claude can inspect the app's data without being handed
// Heshy's Manage password. Deliberately NOT a session: no login, no token minting, and it can
// never authorise a write — see the guard in admin-data.js. Revoke by clearing or changing the
// AGENT_READ_KEY environment variable, which leaves the admin password untouched.
export function verifyAgentKey(req) {
  const supplied = req.headers['x-agent-key'];
  const expected = process.env.AGENT_READ_KEY;
  if (!supplied || !expected) return false;
  if (expected.length < 32) return false; // refuse a weak key outright
  const a = Buffer.from(String(supplied));
  const b = Buffer.from(String(expected));
  // Compare in constant time, without leaking the expected length through an early return.
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

// Cryptographically secure token generation — used for BOTH admin sessions and client portal
// sessions. Previously used Math.random(), which is a statistical generator whose output is
// mathematically predictable and must never be used for security tokens. randomBytes draws from
// the operating system's secure entropy source. 32 bytes = 256 bits, base64url = URL-safe.
export function randomToken() {
  return randomBytes(32).toString('base64url');
}

// A single-purpose, expiring link token. Used so a client can be handed something narrow — "you
// may fill in the strengths assessment for this one client record" — without a login and without
// anything else that a session token would carry.
export async function issueScopedToken(scope, value, ttlSeconds) {
  const token = randomToken();
  await kv.set(scope + ':' + token, value, { ex: ttlSeconds });
  return token;
}

export async function redeemScopedToken(scope, token) {
  if (!token || typeof token !== 'string') return null;
  return (await kv.get(scope + ':' + token)) ?? null;
}
