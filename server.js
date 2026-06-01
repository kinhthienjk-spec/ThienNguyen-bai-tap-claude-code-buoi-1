const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

function loadLocalEnv(fileName) {
  const filePath = path.join(__dirname, fileName);
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}

loadLocalEnv('.env.google-ads.local');
loadLocalEnv('.env.facebook-ads.local');

const googleAdsPerformance = require('./api/google-ads-performance');
const facebookAdsAuth = require('./api/facebook-ads-auth');
const facebookAdsPerformance = require('./api/facebook-ads-performance');
const larkBitable = require('./api/lark-bitable');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ico': 'image/x-icon'
};

function notFound(res) {
  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end('Not found');
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, content) => {
    if (err) return notFound(res);
    const ext = path.extname(filePath).toLowerCase();
    res.statusCode = 200;
    res.setHeader('Content-Type', STATIC_TYPES[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    res.end(content);
  });
}

function staticPath(pathname) {
  const route = pathname === '/' ? '/index-ver-3-codex.html' : pathname;
  if (route.startsWith('/api/')) return null;
  const decoded = decodeURIComponent(route);
  const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const fullPath = path.join(ROOT, normalized);
  if (!fullPath.startsWith(ROOT)) return null;
  const relative = path.relative(ROOT, fullPath).split(path.sep);
  if (relative.some(part => ['.git', '.vercel', 'api'].includes(part))) return null;
  return fullPath;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api/google-ads-performance') {
    req.query = Object.fromEntries(url.searchParams.entries());
    return googleAdsPerformance(req, res);
  }

  if (url.pathname === '/api/facebook-ads-performance') {
    req.query = Object.fromEntries(url.searchParams.entries());
    return facebookAdsPerformance(req, res);
  }

  if (url.pathname.startsWith('/api/facebook-ads/oauth/')) {
    req.query = Object.fromEntries(url.searchParams.entries());
    req.urlPath = url.pathname;
    return facebookAdsAuth(req, res);
  }

  if (url.pathname === '/api/lark-bitable') {
    req.query = Object.fromEntries(url.searchParams.entries());
    return larkBitable(req, res);
  }

  const filePath = staticPath(url.pathname);
  if (!filePath) return notFound(res);
  return serveFile(res, filePath);
});

server.listen(PORT, HOST, () => {
  console.log(`SEONGON dashboard v3 listening on ${HOST}:${PORT}`);
});
