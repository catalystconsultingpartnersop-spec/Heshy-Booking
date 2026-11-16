import { kv } from '@vercel/kv';
import { randomToken } from './_lib/auth.js';
import { logError } from './_lib/errorlog.js';

/**
 * A client signing in with Google. Only their email address is used, and only to find the
 * client record that already exists — Google membership alone grants nothing.
 */
async function handleClientSignIn(code, res) {
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
  if (tokenData.error || !tokenData.access_token) {
    return redirectToPortal(res, 'google-failed');
  }

  const infoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` }
  });
  const info = await infoRes.json();
  const email = String(info?.email || '').toLowerCase().trim();
  // An unverified Google address proves nothing about who owns that inbox.
  if (!email || info.email_verified === false) return redirectToPortal(res, 'google-failed');

  const data = await kv.get('app-data');
  const client = (data?.clients || []).find(c => (c.email || '').toLowerCase().trim() === email);
  if (!client || client.blocked) return redirectToPortal(res, 'google-nomatch');

  const sessionToken = randomToken();
  await kv.set('portal-session:' + sessionToken, client.id, { ex: 60 * 60 * 24 * 14 });
  // Handed back through the fragment, which browsers do not send to servers and which the page
  // clears immediately, rather than in the query string where it would reach logs and history.
  res.writeHead(302, { Location: '/#portal-token=' + encodeURIComponent(sessionToken) });
  res.end();
}

function redirectToPortal(res, reason) {
  res.writeHead(302, { Location: '/#portal-error=' + encodeURIComponent(reason) });
  res.end();
}

export default async function handler(req, res) {
  try {
    const { code, error, state } = req.query;
    if (error) return res.status(400).send('Google sign-in was cancelled or denied.');
    if (!code) return res.status(400).send('Missing authorization code.');
    // Verify the one-time state code, then consume it (single use).
    const stateRecord = state ? await kv.get('oauth-state:' + state) : null;
    if (!stateRecord) {
      return res.status(401).send('Unauthorized request. Please start again.');
    }
    await kv.del('oauth-state:' + state);

    // Two different journeys end up here: Heshy connecting his calendar, and a client signing
    // in to their portal. They must never be confused — a client's sign-in must not be able to
    // overwrite the refresh token that drives the whole calendar integration.
    const purpose = (stateRecord && stateRecord.purpose) || 'calendar';
    if (purpose === 'client-signin') return handleClientSignIn(code, res);

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
