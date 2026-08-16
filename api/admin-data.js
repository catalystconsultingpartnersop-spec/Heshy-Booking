import { kv } from '@vercel/kv';
import { verifyAdminToken } from './_lib/auth.js';

function defaultState() {
  return {
    slots: [],
    bookings: [],
    clients: [],
    settings: { meetLink: '', location: '', intakeQuestions: [] },
    availability: { virtual: [], 'in-person': [] }
  };
}

export default async function handler(req, res) {
  try {
    if (!(await verifyAdminToken(req))) return res.status(401).json({ error: 'Unauthorized' });
    if (req.method === 'GET') {
      const data = (await kv.get('app-data')) || defaultState();
      return res.status(200).json(data);
    }
    if (req.method === 'POST') {
      await kv.set('app-data', req.body);
      return res.status(200).json({ ok: true });
    }
    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
