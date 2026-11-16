import { kv } from '@vercel/kv';
import { logError } from './_lib/errorlog.js';

export default async function handler(req, res) {
  try {
    const { code, error, state } = req.query;
    if (error) return res.status(400).send('Google sign-in was cancelled or denied.');
    if (!code) return res.status(400).send('Missing authorization code.');
    // Verify the one-time state code minted by google-auth-url, then consume it (single use).
    if (!state || !(await kv.get('oauth-state:' + state))) {
      return res.status(401).send('Unauthorized request. Please reconnect from inside Manage.');
    }
    await kv.del('oauth-state:' + state);

    const params = new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: process.env.GOOGLE_REDIRECT_URI,
      grant_type: 'authorization_code'
    });
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params
    });
    const tokenData = await tokenRes.json();
    if (tokenData.error) {
      return res.status(400).send('Google sign-in failed: ' + (tokenData.error_description || tokenData.error));
    }
    if (tokenData.refresh_token) {
      await kv.set('google-refresh-token', tokenData.refresh_token);
    }
    res.writeHead(302, { Location: '/#manage' });
    res.end();
  } catch (err) {
    console.error('Server error:', err);
    await logError('google-callback', err, { method: req.method, action: req.body?.action || req.query?.action });
    res.status(500).send('Something went wrong. Please try again.');
  }
}
