import { kv } from '@vercel/kv';
import { randomBytes } from 'crypto';

export async function verifyAdminToken(req) {
  const token = req.headers['x-admin-token'];
  if (!token) return false;
  const valid = await kv.get('admin-session:' + token);
  return !!valid;
}

// Cryptographically secure token generation — used for BOTH admin sessions and client portal
// sessions. Previously used Math.random(), which is a statistical generator whose output is
// mathematically predictable and must never be used for security tokens. randomBytes draws from
// the operating system's secure entropy source. 32 bytes = 256 bits, base64url = URL-safe.
export function randomToken() {
  return randomBytes(32).toString('base64url');
}
