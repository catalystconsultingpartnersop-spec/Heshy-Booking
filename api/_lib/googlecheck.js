// Does "Sign in with Google" actually work?
//
// This asks Google the real question from the server, where Google is reachable, and reads what
// comes back. It checks the parts that are configuration: whether the client id is recognised,
// whether the redirect address is registered, and whether the sign-in permissions are accepted.
//
// It cannot tell whether the consent screen is still in Testing mode. Google only enforces that
// after someone picks an account, so the only way to know is one real sign-in by somebody who
// isn't the project owner.
//
// Read-only — it changes nothing, anywhere, which is why the read-only key may run it too.

export async function probeGoogleSignIn() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    return { ok: false, problem: 'missing-config',
      message: "Google isn't configured on the server at all (no client id or redirect address)." };
  }

  const probe = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}`
    + `&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code`
    + `&scope=${encodeURIComponent('openid email profile')}&state=probe&prompt=select_account`;

  try {
    const r = await fetch(probe, { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0' } });
    const body = await r.text().catch(() => '');
    const found = m => body.toLowerCase().includes(m);

    if (found('redirect_uri_mismatch')) {
      return { ok: false, problem: 'redirect-mismatch', redirectUri,
        message: "Google doesn't recognise this app's redirect address. It has to be listed exactly, in the Google Cloud console." };
    }
    if (found('invalid_client') || r.status === 401) {
      return { ok: false, problem: 'bad-client',
        message: "Google doesn't recognise the client id this app is using." };
    }
    if (found('invalid_scope')) {
      return { ok: false, problem: 'bad-scope',
        message: 'Google refused the sign-in permissions this app asks for.' };
    }
    if (found('accounterror') || found('error 400') || found('error 401') || found('error 403')) {
      return { ok: false, problem: 'refused', status: r.status,
        message: 'Google refused the request. The exact reason is on its error page.' };
    }

    // A 200 sign-in page, or a redirect into Google's own login flow, both mean the configuration
    // is accepted and a real person would now be asked to choose an account.
    const location = r.headers.get('location') || '';
    const reachedSignIn = r.status === 200
      || (r.status >= 300 && r.status < 400 && /accounts\.google\.com|accounts\.youtube\.com/.test(location));
    if (reachedSignIn) {
      return { ok: true, redirectUri,
        message: 'Google accepted the request and would now ask the client to choose an account.' };
    }
    return { ok: false, problem: 'unexpected', status: r.status,
      message: `Google answered unexpectedly (${r.status}).` };
  } catch (err) {
    return { ok: false, problem: 'unreachable', message: 'Could not reach Google: ' + err.message };
  }
}
