const {
  env,
  graphGet,
  graphGetAll,
  json,
  missingConfig,
  normalizeAdAccountId,
  readSession
} = require('./facebook-ads-session');

const RESULT_ACTION_TYPES = new Set([
  'lead',
  'onsite_conversion.lead_grouped',
  'offsite_conversion.fb_pixel_lead',
  'onsite_web_lead',
  'complete_registration',
  'offsite_conversion.fb_pixel_complete_registration',
  'purchase',
  'omni_purchase',
  'offsite_conversion.fb_pixel_purchase',
  'onsite_conversion.purchase',
  'onsite_conversion.messaging_conversation_started_7d',
  'onsite_conversion.messaging_first_reply'
]);

const VALUE_ACTION_TYPES = new Set([
  'purchase',
  'omni_purchase',
  'offsite_conversion.fb_pixel_purchase',
  'onsite_conversion.purchase'
]);

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

function sumActions(actions, acceptedTypes) {
  if (!Array.isArray(actions)) return 0;
  return actions.reduce((total, action) => {
    const type = String(action.action_type || '');
    return acceptedTypes.has(type) ? total + numberValue(action.value) : total;
  }, 0);
}

function parseRow(row) {
  const spend = numberValue(row.spend);
  const impressions = numberValue(row.impressions);
  const reach = numberValue(row.reach);
  const clicks = numberValue(row.inline_link_clicks || row.clicks);
  const allClicks = numberValue(row.clicks);
  const results = sumActions(row.actions, RESULT_ACTION_TYPES);
  const conversionValue = sumActions(row.action_values, VALUE_ACTION_TYPES);

  return {
    spend,
    impressions,
    reach,
    frequency: numberValue(row.frequency),
    clicks,
    allClicks,
    ctr: impressions ? clicks / impressions : numberValue(row.ctr) / 100,
    averageCpc: clicks ? spend / clicks : numberValue(row.cpc),
    cpm: impressions ? spend / impressions * 1000 : numberValue(row.cpm),
    results,
    costPerResult: results ? spend / results : 0,
    conversionValue,
    roas: spend ? conversionValue / spend : 0
  };
}

function summarize(rows) {
  const totals = rows.reduce((acc, row) => {
    const parsed = parseRow(row);
    acc.spend += parsed.spend;
    acc.impressions += parsed.impressions;
    acc.reach += parsed.reach;
    acc.clicks += parsed.clicks;
    acc.allClicks += parsed.allClicks;
    acc.results += parsed.results;
    acc.conversionValue += parsed.conversionValue;
    return acc;
  }, { spend: 0, impressions: 0, reach: 0, clicks: 0, allClicks: 0, results: 0, conversionValue: 0 });

  return {
    ...totals,
    frequency: totals.reach ? totals.impressions / totals.reach : 0,
    ctr: totals.impressions ? totals.clicks / totals.impressions : 0,
    averageCpc: totals.clicks ? totals.spend / totals.clicks : 0,
    cpm: totals.impressions ? totals.spend / totals.impressions * 1000 : 0,
    costPerResult: totals.results ? totals.spend / totals.results : 0,
    roas: totals.spend ? totals.conversionValue / totals.spend : 0
  };
}

function dailyRows(rows) {
  return rows.map(row => ({
    date: row.date_start || '',
    ...parseRow(row)
  }));
}

function campaignRows(rows) {
  return rows.map(row => ({
    id: row.campaign_id || '',
    name: row.campaign_name || '(unnamed campaign)',
    objective: row.objective || '',
    ...parseRow(row)
  })).sort((a, b) => b.spend - a.spend);
}

async function getAccount(accessToken, accountId) {
  return graphGet(`/${accountId}`, {
    fields: 'id,name,account_status,currency,timezone_name,business_name'
  }, accessToken);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return json(res, 405, { error: 'Method not allowed.' });
  }

  const missing = missingConfig();
  if (missing.length) {
    return json(res, 501, {
      configured: false,
      error: 'Facebook Ads API environment variables are not configured.',
      missingEnv: missing
    });
  }

  const session = readSession(req);
  if (!session) {
    return json(res, 401, {
      configured: true,
      connected: false,
      connectRequired: true,
      error: 'Facebook Ads is not connected. Use the Connect Facebook button to grant ads_read permission.'
    });
  }

  const accountId = normalizeAdAccountId(env('FACEBOOK_AD_ACCOUNT_ID') || session.accountId);
  if (!accountId) {
    return json(res, 400, { error: 'No Facebook ad account is available for this session.' });
  }

  const dateRange = buildDateRange(getRangeDays(req));
  const baseFields = [
    'date_start',
    'date_stop',
    'account_currency',
    'spend',
    'impressions',
    'reach',
    'frequency',
    'clicks',
    'inline_link_clicks',
    'ctr',
    'cpc',
    'cpm',
    'actions',
    'action_values'
  ].join(',');
  const timeRange = JSON.stringify({ since: dateRange.start, until: dateRange.end });

  try {
    const [account, daily, campaigns] = await Promise.all([
      getAccount(session.accessToken, accountId),
      graphGetAll(`/${accountId}/insights`, {
        fields: baseFields,
        level: 'account',
        time_increment: 1,
        time_range: timeRange,
        limit: 500
      }, session.accessToken),
      graphGetAll(`/${accountId}/insights`, {
        fields: `campaign_id,campaign_name,objective,${baseFields}`,
        level: 'campaign',
        time_range: timeRange,
        limit: 100
      }, session.accessToken)
    ]);

    const currencyCode = account.currency || daily[0]?.account_currency || session.currency || 'VND';
    return json(res, 200, {
      configured: true,
      connected: true,
      source: 'meta_marketing_api',
      account: {
        id: accountId,
        name: account.name || session.accountName || accountId,
        status: account.account_status || '',
        currency: currencyCode,
        timezone: account.timezone_name || session.timezone || '',
        businessName: account.business_name || ''
      },
      currencyCode,
      dateRange,
      tokenExpiresAt: session.expiresAt ? new Date(session.expiresAt).toISOString() : null,
      lastUpdated: new Date().toISOString(),
      summary: { ...summarize(daily), currencyCode },
      daily: dailyRows(daily),
      campaigns: campaignRows(campaigns).slice(0, 25)
    });
  } catch (err) {
    return json(res, 502, {
      configured: true,
      connected: true,
      error: err.message || 'Could not query Facebook Ads API.',
      code: err.code || null,
      subcode: err.subcode || null,
      fbtraceId: err.fbtraceId || null
    });
  }
};
