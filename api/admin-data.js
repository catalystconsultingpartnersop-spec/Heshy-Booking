import { kv } from '@vercel/kv';
import { verifyAdminToken, randomToken } from './_lib/auth.js';

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
    if (req.method === 'POST' && req.body && req.body.action === 'login') {
      const { password } = req.body;
      if (!password || password !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Incorrect password' });
      }
      const token = randomToken();
      await kv.set('admin-session:' + token, true);
      return res.status(200).json({ ok: true, token });
    }

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
