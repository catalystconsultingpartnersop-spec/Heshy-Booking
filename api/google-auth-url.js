import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  const token = req.query.token;
  if (!token || !(await kv.get('admin-session:' + token))) {
    return res.status(401).send('Unauthorized. Connect Google Calendar from inside Manage.');
  }
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  const scope = 'https://www.googleapis.com/auth/calendar';
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&access_type=offline&prompt=consent&scope=${encodeURIComponent(scope)}&state=${encodeURIComponent(token)}`;
  res.writeHead(302, { Location: url });
  res.end();
}

