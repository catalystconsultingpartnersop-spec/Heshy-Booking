import { kv } from '@vercel/kv';

export async function verifyAdminToken(req) {
  const token = req.headers['x-admin-token'];
  if (!token) return false;
  const valid = await kv.get('admin-session:' + token);
  return !!valid;
}

export function randomToken() {
  return Array.from({ length: 40 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
}
