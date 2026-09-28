/**
 * Choice history/research adapter.
 *
 * Choice exposes several licensed products through its SDK, but the public
 * site must not guess an undocumented HTTP endpoint or redistribute licensed
 * rows.  The adapter therefore talks to an explicitly configured, trusted
 * HTTPS sidecar.  The sidecar may use c.csd (daily/weekly/monthly/yearly)
 * and returns the small JSON contract documented in README.md.
 */

const CHOICE_HISTORY_DOCS_URL = 'https://quantapi.eastmoney.com/Manual?from=web';
const CHOICE_HISTORY_DOWNLOAD_URL = 'https://quantapi.eastmoney.com/Download?from=web';
const DEFAULT_INDICATORS = 'open,high,low,close,volume';
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 12_000;
const HISTORY_PERIODS = { daily: 1, weekly: 2, monthly: 3, yearly: 4 };
const INTERVAL_LABELS = { daily: '日线', weekly: '周线', monthly: '月线', yearly: '年线' };

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function number(value) {
  if (value === undefined || value === null || text(value) === '') return null;
  const parsed = Number(String(value).replace(/[,，%]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function envValue(env, keys) {
  for (const key of keys) {
    const value = text(env?.[key]);
    if (value) return value;
  }
  return '';
}

function isHttps(value) {
  return /^https:\/\//i.test(text(value));
}

function nowIso() {
  return new Date().toISOString();
}

function timeoutMs(env) {
  const requested = Number(env?.EASTMONEY_CHOICE_HISTORY_TIMEOUT_MS || env?.CHINA_SOURCE_TIMEOUT_MS);
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(800, Math.round(requested)));
}

function historyToken(env) {
  return envValue(env, ['EASTMONEY_CHOICE_HISTORY_TOKEN', 'EASTMONEY_CHOICE_TOKEN', 'CHOICE_ACCESS_TOKEN']);
}

function historyEndpoint(env) {
  return envValue(env, ['EASTMONEY_CHOICE_HISTORY_API_URL']);
}

export function choiceRealtimeEnabled(env = {}) {
  return ['1', 'true', 'yes', 'on'].includes(text(env?.EASTMONEY_CHOICE_REALTIME_ENABLED).toLowerCase());
}

function capability(id, label, status, use, frequency = '') {
  return { id, label, status, use, ...(frequency ? { frequency } : {}) };
}

/**
 * Safe status only: no token, account, endpoint or host is returned.
 * Historical/研究 access is intentionally separated from CSQ/CSQS realtime.
 */
export function choiceHistoryStatus(env = {}) {
  const token = historyToken(env);
  const endpoint = historyEndpoint(env);
  const endpointValid = !endpoint || isHttps(endpoint);
  const configured = Boolean(token && endpoint && endpointValid);
  const realtime = choiceRealtimeEnabled(env);
  const researchStatus = configured ? 'needs_mapping' : 'needs_setup';
  const capabilities = [
    capability('history_daily', '历史日线行情', configured ? 'configured' : 'needs_setup', '用于回测、校准与趋势分析', '日线'),
    capability('history_weekly', '历史周线行情', configured ? 'configured' : 'needs_setup', '用于中周期趋势与风险评估', '周线'),
    capability('history_monthly', '历史月线行情', configured ? 'configured' : 'needs_setup', '用于长期结构分析', '月线'),
    capability('history_yearly', '历史年线行情', configured ? 'configured' : 'needs_setup', '用于长期回溯', '年线'),
    capability('valuation', '估值数据', researchStatus, '已授权待按 Choice 函数映射'),
    capability('financial', '财务数据', researchStatus, '已授权待按 Choice 函数映射'),
    capability('industry', '行业数据', researchStatus, '已授权待按 Choice 函数映射'),
    capability('margin', '融资融券', researchStatus, '已授权待按 Choice 函数映射'),
    capability('realtime', '实时行情', realtime ? 'configured' : 'needs_authorization', realtime ? '已显式启用，仍需实测' : '需交易所/行情授权'),
    capability('minute', '分钟行情', realtime ? 'configured' : 'needs_authorization', realtime ? '已显式启用，仍需实测' : '需交易所/行情授权'),
  ];
  let status = configured ? 'configured' : 'needs_setup';
  let statusLabel = configured ? '历史已配置 · 研究字段待映射' : '历史/研究待配置';
  let message = configured
    ? 'Choice 历史 sidecar 已配置；日/周/月/年序列可进入回测与校准。估值、财务、行业、两融需按已授权函数逐项映射后再读取；实时/分钟仍单独按授权状态处理。'
    : 'Choice 历史/研究通道需要官方账号令牌和你可控的 HTTPS sidecar 地址；本平台不会猜测 Choice 私有 HTTP 地址。';
  let nextStep = configured
    ? '先在本人私有版登录后点击“测试 AU0.SHF 日线”；确认历史数据后，再按 Choice 手册把估值、财务、行业、两融函数加入 sidecar。'
    : '在受信主机部署官方 Choice SDK sidecar，使用 c.csd 拉取历史序列，再配置 EASTMONEY_CHOICE_HISTORY_API_URL 与服务端令牌。';
  if (!endpointValid) {
    status = 'error';
    statusLabel = 'HTTPS 地址无效';
    message = 'Choice 历史 sidecar 地址必须使用 HTTPS；未发送任何请求。';
    nextStep = '将 EASTMONEY_CHOICE_HISTORY_API_URL 改为受信 sidecar 的 HTTPS 地址后重新部署。';
  }
  return {
    id: 'eastmoney_choice_history',
    name: '东方财富 Choice · 历史/研究',
    kind: 'history+research',
    mode: 'official_authorized_api',
    status,
    status_label: statusLabel,
    message,
    next_step: nextStep,
    docs_url: CHOICE_HISTORY_DOCS_URL,
    public_url: CHOICE_HISTORY_DOWNLOAD_URL,
    history_capabilities: capabilities,
    realtime_note: realtime ? '实时/分钟路径已显式启用，必须先完成账号与交易所授权核验。' : '实时/分钟路径未启用；当前不会调用 CSQ/CSQS，也不会把历史数据标成实时。',
    updated_at: nowIso(),
  };
}

function normalizeIndicator(value) {
  const key = text(value).toLowerCase().replace(/[\s_\-]/g, '');
  if (/^(open|开盘|开盘价)$/.test(key)) return 'open';
  if (/^(high|最高|最高价)$/.test(key)) return 'high';
  if (/^(low|最低|最低价)$/.test(key)) return 'low';
  if (/^(close|latest|last|收盘|收盘价|最新价)$/.test(key)) return 'close';
  if (/^(volume|成交量|成交)$/.test(key)) return 'volume';
  return key;
}

function dateText(value) {
  const raw = text(value);
  if (!raw) return '';
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})(?:T|\s)?(\d{2})?(\d{2})?(\d{2})?/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}${compact[4] ? `T${compact[4]}:${compact[5] || '00'}:${compact[6] || '00'}Z` : ''}`;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? raw.slice(0, 10) : parsed.toISOString();
}

function dateList(value) {
  if (Array.isArray(value)) return value.flatMap(dateList).filter(Boolean);
  if (value && typeof value === 'object') {
    for (const key of ['value', 'values', 'data', 'items', 'dates']) {
      if (value[key] !== undefined) return dateList(value[key]);
    }
    return [];
  }
  const raw = text(value);
  return raw ? raw.split(/[,;，；]/).map(dateText).filter(Boolean) : [];
}

function stringList(value) {
  if (Array.isArray(value)) return value.flatMap(stringList).filter(Boolean);
  const raw = text(value);
  return raw ? raw.split(/[,;，；]/).map((item) => item.trim()).filter(Boolean) : [];
}

function valueAt(matrix, indicatorIndex, dateIndex, indicator = '') {
  if (Array.isArray(matrix)) {
    const indicatorRow = matrix[indicatorIndex];
    if (Array.isArray(indicatorRow)) return indicatorRow[dateIndex] ?? null;
    const dateRow = matrix[dateIndex];
    if (Array.isArray(dateRow)) return dateRow[indicatorIndex] ?? null;
    return indicatorIndex === 0 && dateIndex < matrix.length ? matrix[dateIndex] : null;
  }
  if (matrix && typeof matrix === 'object') {
    const keyedIndicator = Object.entries(matrix).find(([key]) => normalizeIndicator(key) === indicator);
    if (keyedIndicator) return valueAt(keyedIndicator[1], 0, dateIndex, indicator);
    const row = matrix[String(indicatorIndex)] ?? matrix[indicatorIndex];
    if (row !== undefined) return valueAt(row, 0, dateIndex, indicator);
    const dateRow = matrix[String(dateIndex)] ?? matrix[dateIndex];
    if (dateRow !== undefined) return valueAt(dateRow, indicatorIndex, 0, indicator);
  }
  return null;
}

function dataForCode(data, code, codeIndex) {
  if (Array.isArray(data)) return data[codeIndex] ?? data[0] ?? null;
  if (!data || typeof data !== 'object') return null;
  const normalized = text(code).toLowerCase().replace(/[\s._\-]/g, '');
  const entry = Object.entries(data).find(([key]) => text(key).toLowerCase().replace(/[\s._\-]/g, '') === normalized);
  return entry ? entry[1] : data[code] ?? data[String(codeIndex)] ?? data;
}

function rowFromObject(raw, fallbackCode = '') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entries = Object.entries(raw);
  const pick = (patterns) => {
    const found = entries.find(([key, value]) => patterns.some((pattern) => pattern.test(text(key).toLowerCase())) && value !== undefined && value !== null && text(value) !== '');
    return found ? found[1] : null;
  };
  const code = text(raw.code || raw.codes || raw.symbol || raw.securityCode || raw.thscode || raw.instrument || fallbackCode);
  const date = dateText(raw.date || raw.datetime || raw.time || raw.timestamp || raw.tradeDate || raw.日期);
  if (!date) return null;
  const row = {
    code,
    date,
    open: number(pick([/^open$/i, /开盘/])) ?? number(raw.open),
    high: number(pick([/^high$/i, /最高/])) ?? number(raw.high),
    low: number(pick([/^low$/i, /最低/])) ?? number(raw.low),
    close: number(pick([/^close$/i, /^latest$/i, /^last$/i, /收盘/, /最新/])) ?? number(raw.close ?? raw.latest ?? raw.last),
    volume: number(pick([/^volume$/i, /成交量/])) ?? number(raw.volume),
  };
  return row.close === null && row.open === null && row.high === null && row.low === null && row.volume === null ? null : row;
}

/**
 * Normalize the documented Choice SDK sequence shape:
 * Codes + Indicators + Dates + Data[code][indicator][date].
 * A row-oriented `items` response is accepted as a convenience for sidecars.
 */
export function extractChoiceHistoryRows(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const candidates = payload.items || payload.rows || payload.records;
  if (Array.isArray(candidates)) {
    return candidates.map((item) => rowFromObject(item)).filter(Boolean);
  }
  const codes = stringList(payload.Codes ?? payload.codes ?? payload.code);
  const indicators = stringList(payload.Indicators ?? payload.indicators ?? DEFAULT_INDICATORS).map(normalizeIndicator);
  const dates = dateList(payload.Dates ?? payload.dates ?? payload.Date ?? payload.date);
  const data = payload.Data ?? payload.data ?? payload.values ?? payload.result;
  if (!codes.length || !dates.length || !data) return [];
  const rows = [];
  codes.forEach((code, codeIndex) => {
    const matrix = dataForCode(data, code, codeIndex);
    dates.forEach((date, dateIndex) => {
      const row = { code, date };
      indicators.forEach((indicator, indicatorIndex) => {
        const value = number(valueAt(matrix, indicatorIndex, dateIndex, indicator));
        if (value === null) return;
        if (['open', 'high', 'low', 'close', 'volume'].includes(indicator)) row[indicator] = value;
      });
      if (Object.keys(row).length > 2) rows.push(row);
    });
  });
  return rows;
}

function failure(code, message, httpStatus = null) {
  const codeText = text(code);
  const messageText = text(message);
  const combined = `${codeText} ${messageText} ${httpStatus || ''}`.toLowerCase();
  if (/10001012|insufficient|no access|permission|forbidden|未授权|权限不足|未开通/.test(combined)) {
    return { status: 'needs_authorization', error_code: codeText || '10001012', error_kind: 'insufficient_user_access', message: 'Choice 历史接口返回权限不足；请确认历史行情/研究数据产品已开通。', next_step: '在 Choice 账户确认历史序列、估值、财务、行业和融资融券权限；实时/分钟另需交易所或行情授权。' };
  }
  if (/401|unauthori[sz]ed|token|令牌/.test(combined)) {
    return { status: 'authentication_error', error_code: codeText || '401', error_kind: 'authentication_error', message: 'Choice 历史 sidecar 令牌认证失败。', next_step: '重新生成官方令牌并只在服务端环境变量中更新。' };
  }
  if (/429|rate|频率|流量/.test(combined)) {
    return { status: 'rate_limited', error_code: codeText || '429', error_kind: 'rate_limited', message: 'Choice 历史接口达到频率或流量限制。', next_step: '检查 Choice 配额并降低轮询频率；历史数据应缓存后复用。' };
  }
  if (/timeout|aborted|超时/.test(combined)) {
    return { status: 'provider_error', error_code: codeText || 'timeout', error_kind: 'timeout', message: 'Choice 历史 sidecar 请求超时。', next_step: '检查受信主机、HTTPS 地址和 SDK 服务状态。' };
  }
  return { status: 'provider_error', error_code: codeText || (httpStatus ? `HTTP ${httpStatus}` : 'provider_error'), error_kind: 'provider_error', message: `Choice 历史接口返回错误${codeText ? `（${codeText}）` : ''}${messageText ? `：${messageText}` : '。'}`, next_step: '核对 sidecar 的 c.csd 参数、合约代码、日期范围和 Choice 权限。' };
}

function payloadFailure(payload, httpStatus = null) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const code = payload.ErrorCode ?? payload.errorCode ?? payload.error_code ?? payload.code ?? payload.errcode;
  const message = payload.ErrorMsg ?? payload.errorMsg ?? payload.error_message ?? payload.message ?? payload.msg ?? (typeof payload.error === 'string' ? payload.error : '');
  const codeText = text(code).toLowerCase();
  const failedCode = codeText && !['0', '200', 'ok', 'success'].includes(codeText);
  if (Number(httpStatus) >= 400 || failedCode || /error|fail|permission|access|授权|权限/i.test(text(message))) return failure(code, message, httpStatus);
  return null;
}

async function fetchWithTimeout(url, options, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function validateDate(value) {
  const raw = text(value);
  if (!raw) return '';
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
}

function dateDaysAgo(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - Math.max(1, Math.min(2_000, Number(days) || 30)));
  return date.toISOString().slice(0, 10);
}

/** Fetch history through the explicitly configured, private Choice sidecar. */
export async function fetchChoiceHistory(env = {}, options = {}) {
  const interval = text(options.interval || 'daily').toLowerCase();
  if (!HISTORY_PERIODS[interval]) {
    return { status: 'needs_authorization', error_kind: 'realtime_not_authorized', message: 'Choice 历史适配器只提供日/周/月/年；小时/分钟需要单独的实时或高频授权。', next_step: '取得交易所/行情授权后走独立的实时/分钟通道。', rows: [], interval };
  }
  const status = choiceHistoryStatus(env);
  if (status.status !== 'configured') return { ...status, rows: [], interval };
  const token = historyToken(env);
  const endpoint = historyEndpoint(env);
  const rawCodes = options.codes || options.code || ['AU0.SHF'];
  const codes = (Array.isArray(rawCodes) ? rawCodes : stringList(rawCodes)).map(text).filter(Boolean).slice(0, 20);
  const startDate = validateDate(options.startDate || options.start) || dateDaysAgo(options.days || 30);
  const endDate = validateDate(options.endDate || options.end) || new Date().toISOString().slice(0, 10);
  const indicators = envValue(env, ['EASTMONEY_CHOICE_HISTORY_INDICATORS']) || DEFAULT_INDICATORS;
  const body = {
    function: 'csd',
    codes,
    indicators,
    startdate: startDate,
    enddate: endDate,
    options: `Period=${HISTORY_PERIODS[interval]},Order=1,AdjustFlag=1,Market=CNFESF,Ispandas=0`,
  };
  try {
    const response = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, access_token: token },
      body: JSON.stringify(body),
    }, timeoutMs(env));
    const raw = await response.text();
    let payload = null;
    try { payload = raw ? JSON.parse(raw) : null; } catch { payload = null; }
    const error = payloadFailure(payload, response.status);
    if (error) return { ...error, rows: [], interval, codes, source_url: CHOICE_HISTORY_DOCS_URL };
    if (!response.ok) return { ...failure(null, `HTTP ${response.status}`, response.status), rows: [], interval, codes, source_url: CHOICE_HISTORY_DOCS_URL };
    const rows = extractChoiceHistoryRows(payload).filter((row) => row.code && row.date).sort((a, b) => `${a.date}|${a.code}`.localeCompare(`${b.date}|${b.code}`));
    return {
      status: rows.length ? 'ok' : 'empty',
      data_mode: 'choice_authorized_history',
      data_label: 'Choice 授权历史数据',
      interval,
      interval_label: INTERVAL_LABELS[interval],
      codes,
      rows,
      row_count: rows.length,
      start_date: startDate,
      end_date: endDate,
      as_of: nowIso(),
      source_url: CHOICE_HISTORY_DOCS_URL,
      next_step: rows.length ? '历史数据已返回，可用于回测与研究；实时/分钟仍保持独立授权边界。' : 'sidecar 返回空结果，请核对 Choice 历史权限、合约代码和日期范围。',
    };
  } catch (cause) {
    const details = failure(null, cause instanceof Error ? cause.message : 'Choice 历史请求失败');
    return { ...details, rows: [], interval, codes, source_url: CHOICE_HISTORY_DOCS_URL };
  }
}

export {
  CHOICE_HISTORY_DOCS_URL,
  CHOICE_HISTORY_DOWNLOAD_URL,
  DEFAULT_INDICATORS,
  HISTORY_PERIODS,
};
