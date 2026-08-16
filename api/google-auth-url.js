export default function handler(req, res) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  const scope = 'https://www.googleapis.com/auth/calendar';
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&access_type=offline&prompt=consent&scope=${encodeURIComponent(scope)}`;
  res.writeHead(302, { Location: url });
  res.end();
}
