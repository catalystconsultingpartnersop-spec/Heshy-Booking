import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  try {
    const email = (req.query.email || '').toLowerCase();
    const data = await kv.get('app-data');
    const client = (data?.clients || []).find(c => c.email.toLowerCase() === email);
    res.status(200).json({ exists: !!client, blocked: !!(client && client.blocked) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
