const crypto = require('crypto');

function json(res, status, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function parseChallenge(challenge, secret) {
  const [payload, signature] = String(challenge || '').split('.');
  if (!payload || !signature || !safeEqual(signature, sign(payload, secret))) {
    return null;
  }
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

function getBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch (err) {
      return {};
    }
  }
  return req.body;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { error: 'Method not allowed.' });
  }

  const secret = process.env.OTP_SECRET;
  if (!secret) {
    return json(res, 500, { error: 'OTP_SECRET is not configured.' });
  }

  try {
    const body = getBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const otp = String(body.otp || '').trim();
    const payload = parseChallenge(body.challenge, secret);

    if (!payload || payload.email !== email || !/^\d{6}$/.test(otp)) {
      return json(res, 401, { error: 'Incorrect or expired code.' });
    }
    if (Date.now() > Number(payload.expiresAt)) {
      return json(res, 401, { error: 'The verification code has expired.' });
    }

    const expectedHash = sign(`${email}:${otp}:${payload.nonce}:${payload.expiresAt}`, secret);
    if (!safeEqual(expectedHash, payload.otpHash)) {
      return json(res, 401, { error: 'Incorrect or expired code.' });
    }

    return json(res, 200, { ok: true });
  } catch (err) {
    return json(res, 401, { error: 'Incorrect or expired code.' });
  }
};
