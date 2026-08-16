import { kv } from '@vercel/kv';
import { randomToken } from './_lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { password } = req.body || {};
    if (!password || password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Incorrect password' });
    }
    const token = randomToken();
    await kv.set('admin-session:' + token, true);
    res.status(200).json({ ok: true, token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
