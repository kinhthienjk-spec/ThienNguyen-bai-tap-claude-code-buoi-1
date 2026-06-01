const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEFAULT_API_VERSION = 'v22';

function json(res, status, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

function env(name) {
  return String(process.env[name] || '').trim();
}

function normalizeCustomerId(value) {
  return String(value || '').replace(/\D/g, '');
}

function getRangeDays(req) {
  const raw = Number(req.query?.range || 30);
  if ([7, 30, 90, 365].includes(raw)) return raw;
  return 30;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function buildDateRange(days) {
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days + 1);
  return { start: isoDate(start), end: isoDate(end), days };
}

function numberValue(value) {
  if (value === null || value === undefined || value === '') return 0;
  return Number(value) || 0;
}

function metric(row, key) {
  return row?.metrics?.[key] ?? row?.metrics?.[key.replace(/[A-Z]/g, m => `_${m.toLowerCase()}`)];
}

function summarize(rows) {
  const totals = rows.reduce((acc, row) => {
    acc.impressions += numberValue(metric(row, 'impressions'));
    acc.clicks += numberValue(metric(row, 'clicks'));
    acc.costMicros += numberValue(metric(row, 'costMicros'));
    acc.conversions += numberValue(metric(row, 'conversions'));
    acc.conversionValue += numberValue(metric(row, 'conversionsValue'));
    return acc;
  }, { impressions: 0, clicks: 0, costMicros: 0, conversions: 0, conversionValue: 0 });

  const spend = totals.costMicros / 1000000;
  return {
    spend,
    impressions: totals.impressions,
    clicks: totals.clicks,
    ctr: totals.impressions ? totals.clicks / totals.impressions : 0,
    averageCpc: totals.clicks ? spend / totals.clicks : 0,
    conversions: totals.conversions,
    conversionRate: totals.clicks ? totals.conversions / totals.clicks : 0,
    costPerConversion: totals.conversions ? spend / totals.conversions : 0,
    conversionValue: totals.conversionValue,
    roas: spend ? totals.conversionValue / spend : 0
  };
}

function flattenSearchStream(payload) {
  if (!Array.isArray(payload)) return [];
  return payload.flatMap(batch => Array.isArray(batch.results) ? batch.results : []);
}

async function getAccessToken() {
  const body = new URLSearchParams({
    client_id: env('GOOGLE_ADS_CLIENT_ID'),
    client_secret: env('GOOGLE_ADS_CLIENT_SECRET'),
    refresh_token: env('GOOGLE_ADS_REFRESH_TOKEN'),
    grant_type: 'refresh_token'
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || 'Could not refresh Google OAuth access token.');
  }
  return data.access_token;
}

async function googleAdsSearchStream({ accessToken, customerId, query }) {
  const version = env('GOOGLE_ADS_API_VERSION') || DEFAULT_API_VERSION;
  const url = `https://googleads.googleapis.com/${version}/customers/${customerId}/googleAds:searchStream`;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': env('GOOGLE_ADS_DEVELOPER_TOKEN'),
    'Content-Type': 'application/json'
  };
  const loginCustomerId = normalizeCustomerId(env('GOOGLE_ADS_LOGIN_CUSTOMER_ID'));
  if (loginCustomerId) headers['login-customer-id'] = loginCustomerId;

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query })
  });
  const requestId = response.headers.get('request-id');
  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const message = data?.error?.message || `Google Ads API request failed with HTTP ${response.status}.`;
    const err = new Error(message);
    err.requestId = requestId;
    throw err;
  }
  return { rows: flattenSearchStream(data), requestId };
}

function dailyRows(rows) {
  return rows.map(row => {
    const summary = summarize([row]);
    return {
      date: row?.segments?.date || '',
      ...summary
    };
  });
}

function campaignRows(rows) {
  return rows.map(row => {
    const summary = summarize([row]);
    return {
      id: row?.campaign?.id || '',
      name: row?.campaign?.name || '(unnamed campaign)',
      channelType: row?.campaign?.advertisingChannelType || '',
      status: row?.campaign?.status || '',
      ...summary
    };
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return json(res, 405, { error: 'Method not allowed.' });
  }

  const required = [
    'GOOGLE_ADS_DEVELOPER_TOKEN',
    'GOOGLE_ADS_CLIENT_ID',
    'GOOGLE_ADS_CLIENT_SECRET',
    'GOOGLE_ADS_REFRESH_TOKEN',
    'GOOGLE_ADS_CUSTOMER_ID'
  ];
  const missingEnv = required.filter(name => !env(name));
  if (missingEnv.length) {
    return json(res, 501, {
      configured: false,
      error: 'Google Ads API environment variables are not configured.',
      missingEnv
    });
  }

  const customerId = normalizeCustomerId(env('GOOGLE_ADS_CUSTOMER_ID'));
  if (!customerId) {
    return json(res, 400, { error: 'GOOGLE_ADS_CUSTOMER_ID must contain a valid numeric customer ID.' });
  }

  const dateRange = buildDateRange(getRangeDays(req));
  const dateFilter = `segments.date BETWEEN '${dateRange.start}' AND '${dateRange.end}'`;
  const dailyQuery = `
    SELECT
      segments.date,
      customer.currency_code,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM customer
    WHERE ${dateFilter}
    ORDER BY segments.date
  `;
  const campaignQuery = `
    SELECT
      campaign.id,
      campaign.name,
      campaign.advertising_channel_type,
      campaign.status,
      customer.currency_code,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM campaign
    WHERE ${dateFilter}
      AND campaign.status != 'REMOVED'
    ORDER BY metrics.cost_micros DESC
    LIMIT 20
  `;

  try {
    const accessToken = await getAccessToken();
    const [dailyResult, campaignResult] = await Promise.all([
      googleAdsSearchStream({ accessToken, customerId, query: dailyQuery }),
      googleAdsSearchStream({ accessToken, customerId, query: campaignQuery })
    ]);
    const rows = dailyResult.rows;
    const currencyCode = rows[0]?.customer?.currencyCode || campaignResult.rows[0]?.customer?.currencyCode || 'VND';

    return json(res, 200, {
      configured: true,
      source: 'google_ads_api',
      customerId,
      currencyCode,
      dateRange,
      lastUpdated: new Date().toISOString(),
      requestIds: [dailyResult.requestId, campaignResult.requestId].filter(Boolean),
      summary: { ...summarize(rows), currencyCode },
      daily: dailyRows(rows),
      campaigns: campaignRows(campaignResult.rows)
    });
  } catch (err) {
    return json(res, 502, {
      configured: true,
      error: err.message || 'Could not query Google Ads API.',
      requestId: err.requestId || null
    });
  }
};
