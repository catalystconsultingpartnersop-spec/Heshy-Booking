import { kv } from '@vercel/kv';

// Tells the booking page whether to show the first-time intake questions.
//
// This endpoint is unauthenticated by necessity (it runs before anyone has booked), so it is
// deliberately kept as quiet as possible:
//   - it no longer reports whether someone is blocked. Blocking is enforced server-side at
//     booking, so saying it here only told a blocked person they'd been blocked.
//   - it is rate limited per caller, so it can't be used to test a list of addresses and work
//     out who Heshy's clients are.
const MAX_LOOKUPS_PER_HOUR = 30;

function callerKey(req) {
  const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.headers['x-real-ip'] || 'unknown';
}

export default async function handler(req, res) {
  try {
    const email = (req.query.email || '').trim().toLowerCase();
    if (!email) return res.status(200).json({ exists: false });

    const key = 'client-check:' + callerKey(req);
    const used = (await kv.get(key)) || 0;
    if (used >= MAX_LOOKUPS_PER_HOUR) {
      // Answer as if brand new rather than erroring, so the booking flow still works for a
      // genuine client behind a shared address: they just see the intake questions again.
      return res.status(200).json({ exists: false });
    }
    await kv.set(key, used + 1, { ex: 3600 });

    const data = await kv.get('app-data');
    const client = (data?.clients || []).find(c => (c.email || '').trim().toLowerCase() === email);
    res.status(200).json({ exists: !!client });
  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
