import { kv } from '@vercel/kv';

function defaultState() {
  return {
    slots: [],
    bookings: [],
    settings: { meetLink: '', location: '' },
    availability: {
      virtual: [
        { id: 'r1', days: [1, 2, 3, 4], start: '11:00', end: '13:00' },
        { id: 'r2', days: [5], start: '10:30', end: '12:30' },
        { id: 'r3', days: [0], start: '10:30', end: '11:30' }
      ],
      'in-person': [
        { id: 'r4', days: [1, 2, 3, 4], start: '11:00', end: '13:00' }
      ]
    }
  };
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const data = await kv.get('app-data');
      return res.status(200).json(data || defaultState());
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
