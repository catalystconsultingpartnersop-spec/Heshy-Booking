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
    const data = (await kv.get('app-data')) || defaultState();
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
