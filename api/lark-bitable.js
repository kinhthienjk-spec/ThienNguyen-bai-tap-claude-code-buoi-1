'use strict';
const https = require('https');

let _token = null;
let _tokenExp = 0;

function larkBase() {
  return (process.env.LARK_DOMAIN || 'https://open.larksuite.com').replace(/\/$/, '');
}

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(text)); }
        catch (e) { reject(new Error(`JSON parse error: ${text.substring(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getToken() {
  if (_token && Date.now() < _tokenExp) return _token;
  const body = JSON.stringify({ app_id: process.env.LARK_APP_ID, app_secret: process.env.LARK_APP_SECRET });
  const url = new URL(`${larkBase()}/open-apis/auth/v3/tenant_access_token/internal`);
  const data = await request({
    hostname: url.hostname, path: url.pathname, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }, body);
  if (!data.tenant_access_token) throw new Error(`Lark auth error: ${data.msg || JSON.stringify(data)}`);
  _token = data.tenant_access_token;
  _tokenExp = Date.now() + Math.max(0, (data.expire || 7200) - 120) * 1000;
  return _token;
}

async function larkGet(path, token) {
  const url = new URL(`${larkBase()}${path}`);
  return request({
    hostname: url.hostname, path: url.pathname + url.search, method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` }
  });
}

async function getAllRecords(appToken, tableId, token) {
  const records = [];
  let pageToken = '';
  do {
    const qs = new URLSearchParams({ page_size: '500' });
    if (pageToken) qs.set('page_token', pageToken);
    const res = await larkGet(`/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records?${qs}`, token);
    if (res.code !== 0) throw new Error(`Records API: ${res.msg} (code ${res.code})`);
    records.push(...(res.data?.items || []));
    pageToken = res.data?.has_more ? (res.data.page_token || '') : '';
  } while (pageToken);
  return records;
}

// ── Field detection ──────────────────────────────────────────────
// Priority: exact match > starts-with > contains; avoid matching ID/formula fields
const STATUS_KEYS = ['active/fail', 'tình trạng sal', 'tình trạng mql', 'trạng thái', 'status', 'stage', 'giai đoạn', 'tình trạng', 'phase'];
const SOURCE_KEYS = ['nguồn', 'kênh lead', 'nguồn lead', 'lead source', 'kênh khai thác', 'kênh'];
const DATE_KEYS   = ['ngày tạo', 'created at', 'creation date', 'create date', 'ngày thành sal', 'ngày', 'date'];
const VALUE_KEYS  = ['giá trị đã ký', 'giá trị đã báo giá', 'giá trị', 'deal value', 'doanh thu', 'revenue', 'budget'];
const NAME_KEYS   = ['tên sal', 'tên khách hàng', 'tên công ty', 'tên', 'khách hàng', 'company', 'name'];
const OWNER_KEYS  = ['chính acc', 'account nhận', 'phụ trách', 'owner', 'assigned', 'nhân viên', 'sale'];

// EXCLUDED types: 11=Person, 15=URL, 18=Formula, 19=LinkRecord, 22=Lookup
const SKIP_TYPES = new Set([11, 15, 18, 19, 22]);

function findField(fields, keys) {
  const eligible = fields.filter(f => !SKIP_TYPES.has(f.type));
  // Pass 1: exact key match, in key priority order
  for (const k of keys) {
    const kl = k.toLowerCase();
    for (const f of eligible) {
      if ((f.field_name || '').toLowerCase() === kl) return f.field_name;
    }
  }
  // Pass 2: contains match, excluding ID/code fields (avoid SourceID, MãMQL etc.)
  for (const k of keys) {
    const kl = k.toLowerCase();
    for (const f of eligible) {
      const n = (f.field_name || '').toLowerCase();
      if (n.includes(kl) && !/ id$| mã | code/i.test(f.field_name)) return f.field_name;
    }
  }
  return null;
}

function extractStr(record, fieldName) {
  if (!fieldName) return null;
  const val = record.fields?.[fieldName];
  if (val === null || val === undefined) return null;
  if (typeof val === 'string') return val || null;
  if (typeof val === 'number') return String(val);
  if (typeof val === 'boolean') return String(val);
  if (Array.isArray(val)) {
    if (!val.length) return null;
    const first = val[0];
    if (typeof first === 'string') return val.join(', ');
    // Lark multi-select: [{value: "text"}] or [{text: "text"}] or [{name: "text"}]
    const texts = val.map(v => v?.text || v?.value || v?.name).filter(Boolean);
    return texts.length ? texts.join(', ') : null;
  }
  if (typeof val === 'object') return val.text || val.value || val.name || null;
  return null;
}

function extractDate(record, fieldName) {
  if (!fieldName) return null;
  const val = record.fields?.[fieldName];
  if (!val) return null;
  // Lark timestamps are ms since epoch
  if (typeof val === 'number' && val > 1e10) return new Date(val).toISOString().split('T')[0];
  if (typeof val === 'number') return new Date(val * 1000).toISOString().split('T')[0];
  if (typeof val === 'string' && val.length >= 8) return val.split('T')[0];
  return null;
}

function extractNum(record, fieldName) {
  if (!fieldName) return 0;
  const val = record.fields?.[fieldName];
  if (typeof val === 'number') return val;
  if (typeof val === 'string') return parseFloat(val.replace(/[^0-9.]/g, '')) || 0;
  return 0;
}

// ── Status / Source normalization ────────────────────────────────
// Handles both generic stages and Seongon-specific BDs pipeline:
// MQL → SAL → SQL → Opp → Contract/Proposal → Close Cus (Won) / Fail (Lost)
function normalizeStatus(raw) {
  if (!raw) return 'Unknown';
  const s = raw.toLowerCase().trim();

  // Seongon-specific: Won states
  if (/close cus|ký hợp đồng|closed won|đã chốt|deal closed|contract signed|chốt hợp đồng|customer/.test(s)) return 'Won';
  // Seongon-specific: Lost states
  if (/fail$|lost$|lose|hủy|không tiếp|cancel|reject|closed lost|không đạt/.test(s)) return 'Lost';
  // Seongon pipeline: MQL
  if (/^mql$|marketing qualified|tiềm năng|potential/.test(s)) return 'MQL';
  // Seongon pipeline: SAL (Sales Accepted Lead) = SQL equivalent
  if (/^sal$|sales accepted/.test(s)) return 'SQL';
  // Seongon pipeline: SQL / Opportunity
  if (/^sql$|sales qualified|^opp$|opportunity|cơ hội/.test(s)) return 'SQL';
  // Seongon pipeline: Proposal / Contract stage
  if (/proposal|demo|đề xuất|báo giá|quote|gửi proposal|contract|hợp đồng/.test(s)) return 'Proposal';
  // Generic: New leads
  if (/mới|new|inbound|unqualified|lead mới|tiếp nhận/.test(s)) return 'New';
  // Generic: Nurturing
  if (/tư vấn|nurtur|contact|đang trao đổi|đang xử lý|in progress|đang tiếp cận|active/.test(s)) return 'Nurturing';
  // Pass-through for unrecognized (will show as their raw value)
  return raw;
}

function normalizeSource(raw) {
  if (!raw) return 'Direct';
  const s = raw.toLowerCase();
  if (/google.*ads|quảng cáo google|google paid|gg ads/.test(s)) return 'Google Ads';
  if (/facebook|meta|fb ads|fb/.test(s)) return 'Facebook/Meta';
  if (/tiktok/.test(s)) return 'TikTok';
  if (/seo|organic|tự nhiên/.test(s)) return 'Organic SEO';
  if (/google(?!.*ads)/.test(s)) return 'Google';
  if (/referral|giới thiệu|recommend|ref/.test(s)) return 'Referral';
  if (/email/.test(s)) return 'Email';
  if (/zalo/.test(s)) return 'Zalo';
  if (/linkedin/.test(s)) return 'LinkedIn';
  if (/website|web|landing/.test(s)) return 'Website';
  if (/cold|outreach/.test(s)) return 'Cold Outreach';
  return raw;
}

// ── Process records ──────────────────────────────────────────────
function processLeads(records, fields) {
  const statusField = findField(fields, STATUS_KEYS);
  const sourceField = findField(fields, SOURCE_KEYS);
  const dateField   = findField(fields, DATE_KEYS);
  const valueField  = findField(fields, VALUE_KEYS);
  const nameField   = findField(fields, NAME_KEYS);
  const ownerField  = findField(fields, OWNER_KEYS);

  const processed = records.map(r => ({
    id: r.record_id,
    name:   extractStr(r, nameField)  || 'Unknown',
    status: normalizeStatus(extractStr(r, statusField)),
    source: normalizeSource(extractStr(r, sourceField)),
    date:   extractDate(r, dateField),
    value:  extractNum(r, valueField),
    owner:  extractStr(r, ownerField),
  }));

  const byStatus = {};
  const bySource = {};
  const byDate   = {};
  let wonCount = 0, wonValue = 0, totalValue = 0;

  processed.forEach(lead => {
    byStatus[lead.status] = (byStatus[lead.status] || 0) + 1;
    bySource[lead.source] = bySource[lead.source] || { count: 0, won: 0, value: 0 };
    bySource[lead.source].count++;
    if (lead.status === 'Won') {
      bySource[lead.source].won++;
      wonCount++;
      wonValue += lead.value;
    }
    totalValue += lead.value;
    if (lead.date) {
      const m = lead.date.substring(0, 7); // YYYY-MM
      byDate[m] = byDate[m] || { total: 0, won: 0, mql: 0, sql: 0 };
      byDate[m].total++;
      if (lead.status === 'Won')      byDate[m].won++;
      if (lead.status === 'MQL')      byDate[m].mql++;
      if (lead.status === 'SQL')      byDate[m].sql++;
    }
  });

  const STAGE_ORDER = ['New', 'Nurturing', 'MQL', 'SQL', 'Proposal', 'Won', 'Lost', 'Unknown'];
  const pipelineStages = STAGE_ORDER
    .map(stage => ({ stage, count: byStatus[stage] || 0 }))
    .filter(s => s.count > 0);

  const sourceArray = Object.entries(bySource)
    .map(([source, d]) => ({
      source, count: d.count, won: d.won, value: d.value,
      winRate: d.count > 0 ? +(d.won / d.count * 100).toFixed(1) : 0
    }))
    .sort((a, b) => b.count - a.count);

  const trendMonths = Object.keys(byDate).sort().slice(-6);
  const trend = trendMonths.map(m => {
    const [yr, mo] = m.split('-');
    return { month: m, label: `T${parseInt(mo)}/${yr.slice(2)}`, ...byDate[m] };
  });

  const recentLeads = processed
    .filter(l => l.date)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .slice(0, 25);

  const fd = {
    new:      byStatus['New']       || 0,
    nurturing: byStatus['Nurturing'] || 0,
    mql:      byStatus['MQL']       || 0,
    sql:      byStatus['SQL']       || 0,
    proposal: byStatus['Proposal']  || 0,
    won:      wonCount,
    lost:     byStatus['Lost']      || 0,
  };

  const active = processed.length - wonCount - fd.lost;
  function safeRate(n, d) { return d > 0 ? +(n / d * 100).toFixed(1) : 0; }

  const pipePre = fd.new + fd.nurturing + fd.mql + fd.sql + fd.proposal + wonCount;
  const convRates = {
    newToMql:       safeRate(fd.mql + fd.sql + fd.proposal + wonCount, pipePre),
    mqlToSql:       safeRate(fd.sql + fd.proposal + wonCount, fd.mql + fd.sql + fd.proposal + wonCount),
    sqlToProposal:  safeRate(fd.proposal + wonCount, fd.sql + fd.proposal + wonCount),
    proposalToWon:  safeRate(wonCount, fd.proposal + wonCount),
    overall:        safeRate(wonCount, processed.length),
  };

  return {
    summary:        { total: processed.length, active, mql: fd.mql, sql: fd.sql, won: wonCount, lost: fd.lost, totalValue, wonValue, winRate: convRates.overall },
    pipelineStages, sourceArray, trend, recentLeads, funnelData: fd, convRates,
    lastUpdated:    new Date().toISOString()
  };
}

// ── Main handler ─────────────────────────────────────────────────
module.exports = async function larkBitable(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const APP_TOKEN = process.env.LARK_BITABLE_APP_TOKEN || 'ERsIbSZ4zaTT4Ls5tO7lqv2fgvb';

  try {
    if (!process.env.LARK_APP_ID || !process.env.LARK_APP_SECRET) {
      res.statusCode = 503;
      return res.end(JSON.stringify({
        error: 'Lark credentials not configured',
        missingEnv: ['LARK_APP_ID', 'LARK_APP_SECRET'].filter(k => !process.env[k])
      }));
    }

    const token = await getToken();

    // List tables
    const tablesRes = await larkGet(`/open-apis/bitable/v1/apps/${APP_TOKEN}/tables`, token);
    if (tablesRes.code !== 0) throw new Error(`Cannot list tables: ${tablesRes.msg} (code ${tablesRes.code})`);
    const tables = tablesRes.data?.items || [];

    if (req.query?.action === 'tables') {
      return res.end(JSON.stringify({ tables: tables.map(t => ({ id: t.table_id, name: t.name })) }));
    }

    // Debug: return raw fields + sample records for a specific table
    if (req.query?.action === 'debug') {
      const tableId = req.query?.tableId || tables[0]?.table_id;
      if (!tableId) return res.end(JSON.stringify({ error: 'No table' }));
      const fieldsRes = await larkGet(`/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/fields`, token);
      const recs = await getAllRecords(APP_TOKEN, tableId, token);
      return res.end(JSON.stringify({
        fields: (fieldsRes.data?.items || []).map(f => ({ name: f.field_name, type: f.type, ui_type: f.ui_type })),
        total: recs.length,
        sample: recs.slice(0, 3).map(r => ({ id: r.record_id, fields: r.fields }))
      }));
    }

    // Step 1: fetch fields for all tables sequentially to avoid rate limits
    function scoreByMeta(name, fields) {
      let s = 0;
      const n = name.toLowerCase();
      if (/bds|lead|mql|sql|pipeline|khách hàng/.test(n)) s += 6;
      if (/data tổng|tổng hợp/.test(n)) s += 4;
      if (findField(fields, STATUS_KEYS)) s += 4;
      if (findField(fields, SOURCE_KEYS)) s += 3;
      if (findField(fields, NAME_KEYS))   s += 2;
      if (findField(fields, DATE_KEYS))   s += 1;
      return s;
    }

    const tablesMeta = [];
    for (const t of tables) {
      const fieldsRes = await larkGet(`/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${t.table_id}/fields`, token);
      const fields    = fieldsRes.data?.items || [];
      tablesMeta.push({ id: t.table_id, name: t.name, fields, score: scoreByMeta(t.name, fields) });
    }
    tablesMeta.sort((a, b) => b.score - a.score);
    const best = tablesMeta[0];

    // Step 2: fetch records ONLY for the best table
    const records   = await getAllRecords(APP_TOKEN, best.id, token);
    const leadsData = processLeads(records, best.fields);

    res.end(JSON.stringify({
      ...leadsData,
      tableName:  best.name,
      tableCount: tables.length,
      allTables:  tablesMeta.map(t => ({ id: t.id, name: t.name, score: t.score }))
    }));

  } catch (err) {
    console.error('[lark-bitable]', err.message);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: err.message }));
  }
};
