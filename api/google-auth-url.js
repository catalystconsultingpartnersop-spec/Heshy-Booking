import { kv } from '@vercel/kv';
import { randomBytes } from 'crypto';

export default async function handler(req, res) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  // Two journeys use the same registered redirect: Heshy connecting his calendar, and a client
  // signing in to their portal. The state record says which, so the callback can never mistake
  // one for the other.
  const purpose = req.query.purpose === 'client-signin' ? 'client-signin' : 'calendar';

  if (purpose === 'calendar') {
    const token = req.query.token;
    if (!token || !(await kv.get('admin-session:' + token))) {
      return res.status(401).send('Unauthorized. Connect Google Calendar from inside Manage.');
    }
  }

  // One-time state code (10-min expiry, deleted on use) instead of passing a session token
  // through Google's redirect chain, where URLs can end up in logs/history.
  const stateNonce = randomBytes(24).toString('base64url');
  await kv.set('oauth-state:' + stateNonce, { purpose }, { ex: 600 });

  // A client sign-in asks only for identity. It must never request calendar or drive access:
  // the point is to learn which email address they own, nothing more.
  const scope = purpose === 'client-signin'
    ? 'openid email profile'
    : 'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/meetings.space.readonly';

  const extras = purpose === 'client-signin'
    ? '&prompt=select_account'
    : '&access_type=offline&prompt=consent';

  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}`
    + `&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code`
    + `&scope=${encodeURIComponent(scope)}&state=${encodeURIComponent(stateNonce)}${extras}`;
  res.writeHead(302, { Location: url });
  res.end();
}

