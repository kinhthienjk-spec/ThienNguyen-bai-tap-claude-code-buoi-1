const crypto = require('crypto');

const OTP_TTL_MS = 10 * 60 * 1000;

function json(res, status, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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

async function sendEmail(email, otp) {
  const from = process.env.OTP_FROM_EMAIL;
  const apiKey = process.env.RESEND_API_KEY;
  if (!from || !apiKey) {
    throw new Error('Email provider is not configured.');
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from,
      to: email,
      subject: 'Your SEONGON AI verification code',
      text: `Your verification code is ${otp}. This code expires in 10 minutes.`,
      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.5;color:#0b1c30">
          <h2>SEONGON AI verification</h2>
          <p>Your verification code is:</p>
          <p style="font-size:28px;font-weight:700;letter-spacing:6px">${otp}</p>
          <p>This code expires in 10 minutes.</p>
        </div>
      `
    })
  });

  if (!response.ok) {
    const details = await response.text().catch(() => '');
    throw new Error(details || 'Email provider rejected the request.');
  }
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
    if (!isValidEmail(email)) {
      return json(res, 400, { error: 'Please enter a valid email address.' });
    }

    const otp = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const nonce = crypto.randomBytes(16).toString('base64url');
    const expiresAt = Date.now() + OTP_TTL_MS;
    const otpHash = sign(`${email}:${otp}:${nonce}:${expiresAt}`, secret);
    const payload = base64url(JSON.stringify({ email, nonce, expiresAt, otpHash }));
    const challenge = `${payload}.${sign(payload, secret)}`;

    await sendEmail(email, otp);

    return json(res, 200, { challenge, expiresAt });
  } catch (err) {
    return json(res, 500, { error: err.message || 'Could not send verification code.' });
  }
};
