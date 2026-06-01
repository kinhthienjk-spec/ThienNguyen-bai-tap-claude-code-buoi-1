const crypto = require('crypto');
const {
  STATE_COOKIE,
  buildRedirectUri,
  clearFacebookCookies,
  env,
  getGraphVersion,
  graphGet,
  html,
  json,
  missingConfig,
  normalizeAdAccountId,
  parseCookies,
  readSession,
  setSessionCookie,
  setStateCookie
} = require('./facebook-ads-session');

function popupResultPage({ ok, message, account }) {
  const safeMessage = String(message || '').replace(/[<>&"']/g, ch => ({
    '<': '\\u003c',
    '>': '\\u003e',
    '&': '\\u0026',
    '"': '\\"',
    "'": "\\'"
  }[ch]));
  const payload = JSON.stringify({
    type: 'facebook-ads-oauth',
    ok,
    message: safeMessage,
    account: account || null
  });

  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Facebook Ads connection</title>
  <style>
    body{font-family:Inter,Arial,sans-serif;background:#f8f9ff;color:#0b1c30;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}
    main{max-width:460px;background:#fff;border:1px solid #dce3f5;border-radius:16px;padding:28px;box-shadow:0 12px 36px rgba(0,26,77,.08)}
    h1{font-size:20px;margin:0 0 8px}
    p{line-height:1.5;margin:0;color:#434656}
  </style>
</head>
<body>
  <main>
    <h1>${ok ? 'Facebook Ads connected' : 'Facebook Ads connection failed'}</h1>
    <p>${safeMessage || (ok ? 'You can close this popup.' : 'Please close this popup and try again.')}</p>
  </main>
  <script>
    const payload = ${payload};
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(payload, window.location.origin);
      setTimeout(() => window.close(), 500);
    }
  </script>
</body>
</html>`;
}

function authScopes() {
  return env('FACEBOOK_OAUTH_SCOPES') || 'ads_read';
}

async function exchangeCodeForToken({ code, redirectUri }) {
  const token = await graphGet('/oauth/access_token', {
    client_id: env('FACEBOOK_APP_ID'),
    client_secret: env('FACEBOOK_APP_SECRET'),
    redirect_uri: redirectUri,
    code
  });

  const longLived = await graphGet('/oauth/access_token', {
    grant_type: 'fb_exchange_token',
    client_id: env('FACEBOOK_APP_ID'),
    client_secret: env('FACEBOOK_APP_SECRET'),
    fb_exchange_token: token.access_token
  });

  const accessToken = longLived.access_token || token.access_token;
  const expiresIn = Number(longLived.expires_in || token.expires_in || 60 * 24 * 60 * 60);
  return {
    accessToken,
    expiresAt: Date.now() + expiresIn * 1000
  };
}

async function chooseAdAccount(accessToken) {
  const configured = normalizeAdAccountId(env('FACEBOOK_AD_ACCOUNT_ID'));
  const accounts = await graphGet('/me/adaccounts', {
    fields: 'id,name,account_status,currency,timezone_name',
    limit: 100
  }, accessToken);
  const data = Array.isArray(accounts.data) ? accounts.data : [];
  const preferred = configured ? data.find(account => normalizeAdAccountId(account.id) === configured) : null;
  const active = data.find(account => Number(account.account_status) === 1);
  const selected = preferred || active || data[0];
  if (!selected) {
    throw new Error('Facebook permission was granted, but no ad account was returned for this user.');
  }
  return {
    id: normalizeAdAccountId(selected.id),
    name: selected.name || selected.id,
    currency: selected.currency || 'VND',
    timezone: selected.timezone_name || ''
  };
}

async function start(req, res) {
  const missing = missingConfig();
  if (missing.length) {
    return html(res, 501, popupResultPage({
      ok: false,
      message: `Missing server environment variables: ${missing.join(', ')}.`
    }));
  }

  const state = crypto.randomBytes(18).toString('hex');
  const redirectUri = buildRedirectUri(req);
  setStateCookie(req, res, state);

  const authUrl = new URL(`https://www.facebook.com/${getGraphVersion()}/dialog/oauth`);
  authUrl.searchParams.set('client_id', env('FACEBOOK_APP_ID'));
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', authScopes());
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('auth_type', 'rerequest');

  res.statusCode = 302;
  res.setHeader('Location', authUrl.toString());
  return res.end();
}

async function callback(req, res) {
  const cookies = parseCookies(req);
  const state = String(req.query?.state || '');
  if (!state || cookies[STATE_COOKIE] !== state) {
    clearFacebookCookies(req, res);
    return html(res, 400, popupResultPage({ ok: false, message: 'Invalid OAuth state. Please try connecting again.' }));
  }

  if (req.query?.error) {
    clearFacebookCookies(req, res);
    return html(res, 400, popupResultPage({ ok: false, message: req.query.error_description || req.query.error }));
  }

  const code = String(req.query?.code || '');
  if (!code) {
    clearFacebookCookies(req, res);
    return html(res, 400, popupResultPage({ ok: false, message: 'Facebook did not return an OAuth code.' }));
  }

  try {
    const redirectUri = buildRedirectUri(req);
    const token = await exchangeCodeForToken({ code, redirectUri });
    const me = await graphGet('/me', { fields: 'id,name' }, token.accessToken);
    const account = await chooseAdAccount(token.accessToken);

    setSessionCookie(req, res, {
      accessToken: token.accessToken,
      expiresAt: token.expiresAt,
      userId: me.id || '',
      userName: me.name || '',
      accountId: account.id,
      accountName: account.name,
      currency: account.currency,
      timezone: account.timezone,
      connectedAt: new Date().toISOString()
    });
    return html(res, 200, popupResultPage({
      ok: true,
      message: `Connected ${account.name}.`,
      account
    }));
  } catch (err) {
    clearFacebookCookies(req, res);
    return html(res, 502, popupResultPage({ ok: false, message: err.message || 'Could not complete Facebook OAuth.' }));
  }
}

function status(req, res) {
  const missing = missingConfig();
  const session = readSession(req);
  return json(res, 200, {
    configured: missing.length === 0,
    missingEnv: missing,
    connected: !!session,
    redirectUri: buildRedirectUri(req),
    account: session ? {
      id: session.accountId,
      name: session.accountName,
      currency: session.currency,
      timezone: session.timezone
    } : null,
    tokenExpiresAt: session?.expiresAt ? new Date(session.expiresAt).toISOString() : null
  });
}

function disconnect(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { error: 'Method not allowed.' });
  }
  clearFacebookCookies(req, res);
  return json(res, 200, { disconnected: true });
}

module.exports = async function handler(req, res) {
  if (req.urlPath === '/api/facebook-ads/oauth/start') return start(req, res);
  if (req.urlPath === '/api/facebook-ads/oauth/callback') return callback(req, res);
  if (req.urlPath === '/api/facebook-ads/oauth/status') return status(req, res);
  if (req.urlPath === '/api/facebook-ads/oauth/disconnect') return disconnect(req, res);
  return json(res, 404, { error: 'Not found.' });
};
