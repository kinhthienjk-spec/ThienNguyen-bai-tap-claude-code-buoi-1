const crypto = require('crypto');

const DEFAULT_GRAPH_VERSION = 'v25.0';
const SESSION_COOKIE = 'fb_ads_session';
const STATE_COOKIE = 'fb_ads_oauth_state';
const SESSION_AAD = Buffer.from('seongon-facebook-ads-session-v1');

function env(name) {
  return String(process.env[name] || '').trim();
}

function json(res, status, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

function html(res, status, body) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = status;
  res.end(body);
}

function parseCookies(req) {
  const header = String(req.headers.cookie || '');
  return header.split(';').reduce((acc, part) => {
    const index = part.indexOf('=');
    if (index === -1) return acc;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) acc[key] = decodeURIComponent(value);
    return acc;
  }, {});
}

function isSecureRequest(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const host = String(req.headers.host || '').toLowerCase();
  return proto === 'https' || (!!host && !host.startsWith('localhost') && !host.startsWith('127.0.0.1'));
}

function serializeCookie(req, name, value, maxAgeSeconds) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`
  ];
  if (isSecureRequest(req)) parts.push('Secure');
  return parts.join('; ');
}

function clearCookie(req, name) {
  return serializeCookie(req, name, '', 0);
}

function appendSetCookie(res, value) {
  const current = res.getHeader('Set-Cookie');
  if (!current) return res.setHeader('Set-Cookie', value);
  if (Array.isArray(current)) return res.setHeader('Set-Cookie', [...current, value]);
  return res.setHeader('Set-Cookie', [current, value]);
}

function getGraphVersion() {
  const version = env('FACEBOOK_GRAPH_API_VERSION') || DEFAULT_GRAPH_VERSION;
  return version.startsWith('v') ? version : `v${version}`;
}

function getCookieSecret() {
  return env('FACEBOOK_COOKIE_SECRET') || env('FACEBOOK_APP_SECRET') || env('SESSION_SECRET');
}

function encryptionKey() {
  const secret = getCookieSecret();
  if (!secret) return null;
  return crypto.createHash('sha256').update(secret).digest();
}

function base64Url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function encryptSession(payload) {
  const key = encryptionKey();
  if (!key) throw new Error('Missing FACEBOOK_COOKIE_SECRET or FACEBOOK_APP_SECRET for session encryption.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(SESSION_AAD);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', base64Url(iv), base64Url(tag), base64Url(encrypted)].join('.');
}

function decryptSession(value) {
  const key = encryptionKey();
  if (!key || !value) return null;
  const [version, ivRaw, tagRaw, encryptedRaw] = String(value).split('.');
  if (version !== 'v1' || !ivRaw || !tagRaw || !encryptedRaw) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivRaw, 'base64url'));
    decipher.setAAD(SESSION_AAD);
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encryptedRaw, 'base64url')),
      decipher.final()
    ]).toString('utf8');
    const session = JSON.parse(decrypted);
    if (!session?.accessToken || Number(session.expiresAt || 0) <= Date.now()) return null;
    return session;
  } catch (err) {
    return null;
  }
}

function readSession(req) {
  return decryptSession(parseCookies(req)[SESSION_COOKIE]);
}

function setSessionCookie(req, res, session) {
  const expiresAt = Number(session.expiresAt || 0);
  const maxAge = expiresAt > Date.now() ? Math.floor((expiresAt - Date.now()) / 1000) : 3600;
  appendSetCookie(res, serializeCookie(req, SESSION_COOKIE, encryptSession(session), Math.min(maxAge, 60 * 24 * 60 * 60)));
}

function setStateCookie(req, res, state) {
  appendSetCookie(res, serializeCookie(req, STATE_COOKIE, state, 10 * 60));
}

function clearFacebookCookies(req, res) {
  appendSetCookie(res, clearCookie(req, SESSION_COOKIE));
  appendSetCookie(res, clearCookie(req, STATE_COOKIE));
}

function missingConfig() {
  return ['FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET'].filter(name => !env(name));
}

function originFromRequest(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (isSecureRequest(req) ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
  return `${proto}://${String(host).split(',')[0].trim()}`;
}

function buildRedirectUri(req) {
  return env('FACEBOOK_OAUTH_REDIRECT_URI') || `${originFromRequest(req)}/api/facebook-ads/oauth/callback`;
}

function normalizeAdAccountId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^act_\d+$/.test(raw)) return raw;
  const digits = raw.replace(/\D/g, '');
  return digits ? `act_${digits}` : '';
}

async function graphGet(pathOrUrl, params = {}, accessToken) {
  const url = pathOrUrl.startsWith('http')
    ? new URL(pathOrUrl)
    : new URL(`https://graph.facebook.com/${getGraphVersion()}${pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  });
  if (accessToken && !url.searchParams.has('access_token')) url.searchParams.set('access_token', accessToken);

  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    const error = data.error || {};
    const message = error.message || `Facebook Graph API request failed with HTTP ${response.status}.`;
    const err = new Error(message);
    err.status = response.status;
    err.code = error.code;
    err.subcode = error.error_subcode || error.subcode;
    err.fbtraceId = error.fbtrace_id;
    throw err;
  }
  return data;
}

async function graphGetAll(path, params, accessToken, maxPages = 5) {
  const rows = [];
  let payload = await graphGet(path, params, accessToken);
  let pages = 0;
  while (payload && pages < maxPages) {
    if (Array.isArray(payload.data)) rows.push(...payload.data);
    const next = payload.paging?.next;
    if (!next) break;
    payload = await graphGet(next, {}, accessToken);
    pages += 1;
  }
  return rows;
}

module.exports = {
  STATE_COOKIE,
  buildRedirectUri,
  clearFacebookCookies,
  env,
  getGraphVersion,
  graphGet,
  graphGetAll,
  html,
  json,
  missingConfig,
  normalizeAdAccountId,
  parseCookies,
  readSession,
  setSessionCookie,
  setStateCookie
};
