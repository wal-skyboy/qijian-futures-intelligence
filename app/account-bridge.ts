export type AccountBridgeStatus = 'ok' | 'partial' | 'disconnected' | 'invalid' | 'needs_consent' | string;

export type BridgePosition = {
  symbol: string;
  name?: string;
  direction?: '多' | '空' | 'flat' | 'unknown' | string;
  quantity: number;
  avg_price: number | null;
  last_price: number | null;
  unrealized_pnl: number | null;
  margin: number | null;
  currency?: string;
  as_of: string;
  source?: string;
  data_mode?: string;
};

export type BridgeAccount = {
  equity: number | null;
  available: number | null;
  margin_used: number | null;
  unrealized_pnl: number | null;
  currency?: string;
};

export type BridgeRisk = {
  score: number;
  band: '待验证' | '低' | '中' | '高';
  stale: boolean;
  age_seconds: number | null;
  gross_exposure: number | null;
  margin_ratio: number | null;
  concentration: number | null;
  missing_price_count: number;
  warnings: string[];
};

export type AccountBridgePayload = {
  status: AccountBridgeStatus;
  read_only: true;
  order_enabled: false;
  source?: string;
  source_url?: string;
  as_of?: string;
  latency_ms?: number | null;
  positions: BridgePosition[];
  account?: BridgeAccount;
  risk: BridgeRisk;
  message?: string;
  data_mode?: string;
};

export type BridgeValidationResult =
  | { ok: true; payload: AccountBridgePayload }
  | { ok: false; message: string };

const MAX_POSITIONS = 200;
const STALE_AFTER_SECONDS = 30;
const SENSITIVE_KEY = /(password|passwd|secret|token|cookie|session|otp|one.?time|authorization|api.?key|access.?code|account.?id|investor.?id)/i;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const text = (value: unknown, max = 160): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
};

const finiteNumber = (value: unknown, allowNull = true): number | null | undefined => {
  if (value === null && allowNull) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
};

/** Optional numeric fields are allowed to be omitted by a minimal sidecar.
 * Explicitly malformed values are still rejected so a missing quote can never
 * be mistaken for a valid zero.
 */
const optionalNumber = (value: unknown): number | null | undefined => {
  if (value === undefined || value === null) return null;
  return finiteNumber(value, false);
};

const hasSensitiveKey = (value: unknown, depth = 0): boolean => {
  if (depth > 4 || !value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(item => hasSensitiveKey(item, depth + 1));
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => SENSITIVE_KEY.test(key) || hasSensitiveKey(child, depth + 1));
};

const validTimestamp = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));

const normalisePosition = (raw: unknown): BridgePosition | null => {
  if (!isRecord(raw)) return null;
  const symbol = text(raw.symbol, 80);
  const asOf = text(raw.as_of, 80);
  if (!symbol || !asOf || !validTimestamp(asOf)) return null;
  const quantity = finiteNumber(raw.quantity, false);
  const avgPrice = optionalNumber(raw.avg_price);
  const lastPrice = optionalNumber(raw.last_price);
  const unrealizedPnl = optionalNumber(raw.unrealized_pnl);
  const margin = optionalNumber(raw.margin);
  if (quantity === undefined || quantity === null || quantity < 0 || avgPrice === undefined || lastPrice === undefined || unrealizedPnl === undefined || margin === undefined) return null;
  return {
    symbol,
    name: text(raw.name, 80),
    direction: text(raw.direction, 20) || 'unknown',
    quantity,
    avg_price: avgPrice,
    last_price: lastPrice,
    unrealized_pnl: unrealizedPnl,
    margin,
    currency: text(raw.currency, 16),
    as_of: asOf,
    source: text(raw.source, 120),
    data_mode: text(raw.data_mode, 80),
  };
};

const normaliseAccount = (raw: unknown): BridgeAccount | undefined => {
  if (!isRecord(raw)) return undefined;
  const equity = optionalNumber(raw.equity);
  const available = optionalNumber(raw.available);
  const marginUsed = optionalNumber(raw.margin_used);
  const unrealizedPnl = optionalNumber(raw.unrealized_pnl);
  if (equity === undefined || available === undefined || marginUsed === undefined || unrealizedPnl === undefined) return undefined;
  return { equity, available, margin_used: marginUsed, unrealized_pnl: unrealizedPnl, currency: text(raw.currency, 16) };
};

export const deriveAccountBridgeRisk = (payload: Pick<AccountBridgePayload, 'status' | 'as_of' | 'positions' | 'account'>, now = Date.now()): BridgeRisk => {
  const timestamps = [payload.as_of, ...payload.positions.map(position => position.as_of)].filter(validTimestamp).map(value => Date.parse(value));
  const newest = timestamps.length ? Math.max(...timestamps) : null;
  const ageSeconds = newest === null ? null : Math.max(0, Math.round((now - newest) / 1000));
  const stale = ageSeconds === null || ageSeconds > STALE_AFTER_SECONDS;
  const exposures = payload.positions.map(position => {
    if (position.last_price === null || position.quantity <= 0) return null;
    return Math.abs(position.last_price * position.quantity);
  });
  const validExposures = exposures.filter((value): value is number => value !== null && Number.isFinite(value));
  const grossExposure = validExposures.length ? validExposures.reduce((sum, value) => sum + value, 0) : null;
  const concentration = grossExposure && grossExposure > 0 ? Math.max(...validExposures) / grossExposure : null;
  const equity = payload.account?.equity;
  const marginUsed = payload.account?.margin_used;
  const marginRatio = typeof equity === 'number' && equity > 0 && typeof marginUsed === 'number' && marginUsed >= 0 ? marginUsed / equity : null;
  const missingPriceCount = payload.positions.filter(position => position.quantity > 0 && position.last_price === null).length;
  const warnings: string[] = [];
  let score = 0;
  if (payload.status === 'disconnected' || payload.status === 'invalid' || payload.status === 'needs_consent') {
    score += 50;
    warnings.push('数据桥未连接或未获授权，暂停新增仓位');
  }
  if (stale) {
    score += 30;
    warnings.push(ageSeconds === null ? '缺少有效时间戳' : `行情已超过 ${STALE_AFTER_SECONDS} 秒未更新`);
  }
  if (marginRatio !== null && marginRatio > 0.6) {
    score += 35;
    warnings.push(`保证金占用 ${(marginRatio * 100).toFixed(1)}%，建议先降杠杆`);
  } else if (marginRatio !== null && marginRatio > 0.4) {
    score += 20;
    warnings.push(`保证金占用 ${(marginRatio * 100).toFixed(1)}%，接近警戒线`);
  }
  if (concentration !== null && concentration > 0.5) {
    score += 35;
    warnings.push(`单品种敞口 ${(concentration * 100).toFixed(1)}%，集中度过高`);
  } else if (concentration !== null && concentration > 0.25) {
    score += 22;
    warnings.push(`单品种敞口 ${(concentration * 100).toFixed(1)}%，注意分散`);
  }
  if (missingPriceCount > 0) {
    score += 15;
    warnings.push(`${missingPriceCount} 个持仓缺少最新价，暂不计算完整风险`);
  }
  if (!payload.positions.length) {
    score += 10;
    warnings.push('当前没有可分析的持仓');
  }
  score = Math.min(100, score);
  const band: BridgeRisk['band'] = score >= 70 ? '高' : score >= 35 ? '中' : score > 0 ? '低' : '待验证';
  return { score, band, stale, age_seconds: ageSeconds, gross_exposure: grossExposure, margin_ratio: marginRatio, concentration, missing_price_count: missingPriceCount, warnings: [...new Set(warnings)] };
};

export const deriveAccountBridgeStrategy = (risk: BridgeRisk, status: AccountBridgeStatus): string => {
  if (status !== 'ok' && status !== 'partial') return '暂停新增仓位，先恢复只读数据桥并确认时间戳；不自动下单。';
  if (risk.stale) return '数据已过期，暂停新增仓位；恢复连续报价后再评估信号。';
  if (risk.margin_ratio !== null && risk.margin_ratio > 0.6) return '优先降杠杆、释放保证金；暂不追单，等待占用率回到警戒线下。';
  if (risk.concentration !== null && risk.concentration > 0.25) return '降低单品种集中度，分散敞口后再评估；单笔风险控制在 0.5R 以内。';
  if (risk.missing_price_count > 0) return '补齐持仓最新价与合约口径后再分析；不使用缺价数据生成方向结论。';
  return '仅在多源信号、止损和流动性同时满足时评估；单品种风险 ≤ 0.5R，组合敞口 ≤ 30%，不自动下单。';
};

export const normaliseAccountBridgePayload = (raw: unknown, sourceUrl?: string): BridgeValidationResult => {
  if (!isRecord(raw)) return { ok: false, message: '桥接返回不是 JSON 对象' };
  if (hasSensitiveKey(raw)) return { ok: false, message: '返回内容包含密码、令牌、Cookie 或账户标识字段，已拒绝处理' };
  if (raw.read_only !== true || raw.order_enabled !== false) return { ok: false, message: '安全校验失败：桥接必须明确 read_only=true 且 order_enabled=false' };
  if (!Array.isArray(raw.positions)) return { ok: false, message: '缺少 positions 数组' };
  if (raw.positions.length > MAX_POSITIONS) return { ok: false, message: `持仓数量超过 ${MAX_POSITIONS} 条上限` };
  const positions = raw.positions.map(normalisePosition);
  if (positions.some(position => position === null)) return { ok: false, message: '持仓字段不完整或包含无效数字/时间戳' };
  const status = text(raw.status, 40) || 'invalid';
  const asOf = text(raw.as_of, 80);
  if (asOf && !validTimestamp(asOf)) return { ok: false, message: 'as_of 不是有效时间戳' };
  const latency = optionalNumber(raw.latency_ms);
  if (latency === undefined) return { ok: false, message: 'latency_ms 不是有效数字' };
  const account = raw.account === undefined ? undefined : normaliseAccount(raw.account);
  if (raw.account !== undefined && !account) return { ok: false, message: 'account 字段包含无效数字' };
  const payloadBase = {
    status,
    read_only: true as const,
    order_enabled: false as const,
    source: text(raw.source, 120),
    source_url: sourceUrl,
    as_of: asOf,
    latency_ms: latency,
    positions: positions as BridgePosition[],
    account,
    message: text(raw.message, 240),
    data_mode: text(raw.data_mode, 80),
  };
  const risk = deriveAccountBridgeRisk(payloadBase, Date.now());
  return { ok: true, payload: { ...payloadBase, risk } };
};

export const validateBridgeUrl = (value: string): { ok: true; url: string } | { ok: false; message: string } => {
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, message: '请输入本机只读桥接 URL' };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, message: 'URL 格式无效，仅支持 http:// 或 https://' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return { ok: false, message: '仅支持 http:// 或 https:// URL' };
  if (parsed.username || parsed.password) return { ok: false, message: 'URL 不得包含用户名或密码' };
  for (const key of parsed.searchParams.keys()) {
    if (SENSITIVE_KEY.test(key)) return { ok: false, message: 'URL 不得携带令牌、密码或 Cookie 参数' };
  }
  return { ok: true, url: parsed.toString() };
};

export const bridgeStatusLabel = (status: AccountBridgeStatus): string => {
  if (status === 'ok') return '已连接';
  if (status === 'partial') return '部分数据';
  if (status === 'disconnected') return '未连接';
  if (status === 'needs_consent') return '待授权';
  if (status === 'invalid') return '安全校验失败';
  return '待配置';
};
