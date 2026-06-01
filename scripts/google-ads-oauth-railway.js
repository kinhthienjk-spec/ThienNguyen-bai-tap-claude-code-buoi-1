const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const SERVICE = process.env.RAILWAY_SERVICE || 'seongon-marketing-dashboard-v3';
const ENVIRONMENT = process.env.RAILWAY_ENVIRONMENT || 'production';
const SCOPE = 'https://www.googleapis.com/auth/adwords';
const LOCAL_ENV_FILE = path.join(__dirname, '..', '.env.google-ads.local');

function loadLocalEnv() {
  if (!fs.existsSync(LOCAL_ENV_FILE)) return;
  const lines = fs.readFileSync(LOCAL_ENV_FILE, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, raw] = match;
    if (process.env[key]) continue;
    process.env[key] = raw.replace(/^['"]|['"]$/g, '');
  }
}

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function openBrowser(url) {
  const command = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore' });
  child.unref();
}

function runRailway(args, stdinValue) {
  return new Promise((resolve, reject) => {
    const bin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const child = spawn(bin, ['@railway/cli', ...args], {
      cwd: path.join(__dirname, '..'),
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error((stderr || stdout || `railway exited with ${code}`).trim()));
    });
    child.stdin.end(stdinValue || '');
  });
}

function waitForOAuthCode({ port, state }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host || `127.0.0.1:${port}`}`);
      if (url.pathname !== '/oauth2callback') {
        res.statusCode = 404;
        return res.end('Not found');
      }
      if (url.searchParams.get('state') !== state) {
        res.statusCode = 400;
        res.end('Invalid OAuth state. You can close this tab.');
        server.close();
        return reject(new Error('Invalid OAuth state.'));
      }
      const error = url.searchParams.get('error');
      if (error) {
        res.statusCode = 400;
        res.end(`Google OAuth error: ${error}. You can close this tab.`);
        server.close();
        return reject(new Error(`Google OAuth error: ${error}`));
      }
      const code = url.searchParams.get('code');
      if (!code) {
        res.statusCode = 400;
        res.end('Missing OAuth code. You can close this tab.');
        server.close();
        return reject(new Error('Missing OAuth code.'));
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<h2>Google Ads connected.</h2><p>You can close this tab and return to the terminal.</p>');
      server.close();
      resolve(code);
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1');
  });
}

async function exchangeCodeForRefreshToken({ code, clientId, clientSecret, redirectUri }) {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code'
  });
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error_description || data.error || 'Could not exchange OAuth code.');
  }
  if (!data.refresh_token) {
    throw new Error('Google did not return a refresh token. Re-run with prompt consent or remove the app access from your Google Account first.');
  }
  return data.refresh_token;
}

async function setRailwayVariable(key, value) {
  process.stdout.write(`Setting Railway variable ${key}... `);
  await runRailway([
    'variable',
    'set',
    key,
    '--stdin',
    '--skip-deploys',
    '--service',
    SERVICE,
    '--environment',
    ENVIRONMENT
  ], value);
  process.stdout.write('done\n');
}

async function main() {
  loadLocalEnv();

  const clientId = requiredEnv('GOOGLE_ADS_CLIENT_ID');
  const clientSecret = requiredEnv('GOOGLE_ADS_CLIENT_SECRET');
  const developerToken = requiredEnv('GOOGLE_ADS_DEVELOPER_TOKEN');
  const customerId = requiredEnv('GOOGLE_ADS_CUSTOMER_ID');
  const loginCustomerId = String(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '').trim();
  const port = Number(process.env.GOOGLE_OAUTH_REDIRECT_PORT || 53682);
  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
  const state = crypto.randomBytes(18).toString('hex');

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPE);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('state', state);

  const codePromise = waitForOAuthCode({ port, state });
  console.log(`Opening Google OAuth in your browser. Redirect URI: ${redirectUri}`);
  openBrowser(authUrl.toString());
  const code = await codePromise;
  console.log('OAuth code received. Exchanging for refresh token...');
  const refreshToken = await exchangeCodeForRefreshToken({ code, clientId, clientSecret, redirectUri });

  const variables = {
    GOOGLE_ADS_DEVELOPER_TOKEN: developerToken,
    GOOGLE_ADS_CLIENT_ID: clientId,
    GOOGLE_ADS_CLIENT_SECRET: clientSecret,
    GOOGLE_ADS_REFRESH_TOKEN: refreshToken,
    GOOGLE_ADS_CUSTOMER_ID: customerId,
    GOOGLE_ADS_API_VERSION: process.env.GOOGLE_ADS_API_VERSION || 'v22'
  };
  if (loginCustomerId) variables.GOOGLE_ADS_LOGIN_CUSTOMER_ID = loginCustomerId;

  for (const [key, value] of Object.entries(variables)) {
    await setRailwayVariable(key, value);
  }

  console.log('Redeploying Railway service so variables take effect...');
  await runRailway(['service', 'redeploy', '--yes', '--service', SERVICE, '--environment', ENVIRONMENT]);
  console.log('Done. Railway has the Google Ads variables and a redeploy has been started.');
}

main().catch(err => {
  console.error(`\n${err.message}`);
  console.error(`\nCreate ${path.basename(LOCAL_ENV_FILE)} from .env.google-ads.local.example, fill the required values, then run: npm run google-ads:connect`);
  process.exit(1);
});
