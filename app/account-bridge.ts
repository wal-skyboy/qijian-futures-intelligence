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

export type BridgeQuote = {
  symbol: string;
  name?: string;
  contract?: string;
  latest: number | null;
  change: number | null;
  change_pct: number | null;
  average: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  prev_close: number | null;
  bid1: number | null;
  ask1: number | null;
  bid1_qty: number | null;
  ask1_qty: number | null;
  volume: number | null;
  open_interest: number | null;
  currency?: string;
  as_of: string;
  source?: string;
};

export type BridgeDepthLevel = { price: number; quantity: number };

export type BridgeOrderBook = {
  bids: BridgeDepthLevel[];
  asks: BridgeDepthLevel[];
  as_of?: string;
};

export type BridgeTrade = {
  time: string;
  price: number;
  quantity: number;
  direction?: string;
  open_close?: string;
  position_change?: number | null;
};

export type BridgeCandle = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number | null;
  open_interest?: number | null;
};

export type BridgeCandleSeries = {
  interval: string;
  rows: BridgeCandle[];
  as_of?: string;
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
  quote?: BridgeQuote;
  order_book?: BridgeOrderBook;
  trades?: BridgeTrade[];
  candle_series?: BridgeCandleSeries[];
  risk: BridgeRisk;
  message?: string;
  data_mode?: string;
};

export type BridgeValidationResult =
  | { ok: true; payload: AccountBridgePayload }
  | { ok: false; message: string };

const MAX_POSITIONS = 200;
const MAX_TRADES = 240;
const MAX_CANDLE_ROWS = 1200;
const MAX_DEPTH_LEVELS = 10;
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

const numericValue = (value: unknown): number | null | undefined => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const hasWan = /万$/u.test(value.trim());
  const cleaned = value.replace(/[,%\s]/g, '').replace(/万$/u, '').trim();
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? (hasWan ? parsed * 10000 : parsed) : undefined;
};

const firstValue = (raw: Record<string, unknown>, keys: string[]): unknown => {
  for (const key of keys) {
    if (raw[key] !== undefined) return raw[key];
  }
  return undefined;
};

const aliasedText = (raw: Record<string, unknown>, keys: string[], max = 120): string | undefined => text(firstValue(raw, keys), max);

const aliasedNumber = (raw: Record<string, unknown>, keys: string[]): number | null | undefined => numericValue(firstValue(raw, keys));

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

const normaliseQuote = (raw: unknown, fallbackAsOf?: string): BridgeQuote | null => {
  if (!isRecord(raw)) return null;
  const symbol = aliasedText(raw, ['symbol', 'code', 'contract_code', '代码', '期货代码', '合约代码'], 80);
  const asOf = aliasedText(raw, ['as_of', 'updated_at', 'timestamp', 'time', '数据时间'], 80) || fallbackAsOf;
  if (!symbol || !asOf || !validTimestamp(asOf)) return null;
  const fields = (keys: string[]) => aliasedNumber(raw, keys);
  const values = [
    fields(['latest', 'last', 'price', '最新', '最新价', '现价']),
    fields(['change', 'change_amount', '涨跌', '涨跌额']),
    fields(['change_pct', 'changeRatio', 'change_rate', '涨幅', '涨跌幅']),
    fields(['average', 'avg', '均价', '均价价']),
    fields(['open', 'open_price', '今开', '开盘']),
    fields(['high', '最高', '最高价']),
    fields(['low', '最低', '最低价']),
    fields(['prev_close', 'pre_close', '昨结', '前收']),
    fields(['bid1', 'bid', '买一价', '买入价', '买价']),
    fields(['ask1', 'ask', '卖一价', '卖出价', '卖价']),
    fields(['bid1_qty', 'bid_qty', '买一量', '买入量', '买量']),
    fields(['ask1_qty', 'ask_qty', '卖一量', '卖出量', '卖量']),
    fields(['volume', '成交量', '总手']),
    fields(['open_interest', '持仓量', '持仓']),
  ];
  if (values.some(value => value === undefined)) return null;
  return {
    symbol,
    name: aliasedText(raw, ['name', 'contract_name', '名称', '合约名称'], 80),
    contract: aliasedText(raw, ['contract', '合约', '合约名称'], 80),
    latest: values[0] ?? null,
    change: values[1] ?? null,
    change_pct: values[2] ?? null,
    average: values[3] ?? null,
    open: values[4] ?? null,
    high: values[5] ?? null,
    low: values[6] ?? null,
    prev_close: values[7] ?? null,
    bid1: values[8] ?? null,
    ask1: values[9] ?? null,
    bid1_qty: values[10] ?? null,
    ask1_qty: values[11] ?? null,
    volume: values[12] ?? null,
    open_interest: values[13] ?? null,
    currency: aliasedText(raw, ['currency', '币种', '货币'], 16),
    as_of: asOf,
    source: aliasedText(raw, ['source', '来源'], 120),
  };
};

const normaliseDepth = (raw: unknown, fallbackAsOf?: string): BridgeOrderBook | undefined => {
  if (!isRecord(raw)) return undefined;
  const read = (value: unknown): BridgeDepthLevel[] | null => {
    if (!Array.isArray(value)) return null;
    if (value.length > MAX_DEPTH_LEVELS) return null;
    const rows = value.map(item => {
      if (!isRecord(item)) return null;
      const price = aliasedNumber(item, ['price', '价', '价格']);
      const quantity = aliasedNumber(item, ['quantity', 'qty', 'volume', '量', '数量']);
      if (price === undefined || price === null || quantity === undefined || quantity === null || price < 0 || quantity < 0) return null;
      return { price, quantity };
    });
    return rows.some(row => row === null) ? null : rows as BridgeDepthLevel[];
  };
  const bids = read(firstValue(raw, ['bids', 'bid', '买盘', '买方'])) || [];
  const asks = read(firstValue(raw, ['asks', 'ask', '卖盘', '卖方'])) || [];
  const asOf = aliasedText(raw, ['as_of', 'updated_at', 'timestamp', 'time', '数据时间'], 80) || fallbackAsOf;
  if (asOf && !validTimestamp(asOf)) return undefined;
  return { bids, asks, as_of: asOf };
};

const normaliseTrades = (raw: unknown): BridgeTrade[] | undefined => {
  if (!Array.isArray(raw)) return undefined;
  if (raw.length > MAX_TRADES) return undefined;
  const rows = raw.map(item => {
    if (!isRecord(item)) return null;
    const time = aliasedText(item, ['time', 'timestamp', '成交时间', '时间'], 80);
    const price = aliasedNumber(item, ['price', '成交价', '价格']);
    const quantity = aliasedNumber(item, ['quantity', 'qty', 'volume', '成交量', '数量']);
    if (!time || !validTimestamp(time) || price === undefined || price === null || quantity === undefined || quantity === null || price < 0 || quantity < 0) return null;
    return { time, price, quantity, direction: aliasedText(item, ['direction', 'side', '方向'], 16), open_close: aliasedText(item, ['open_close', 'offset', '开平'], 16), position_change: aliasedNumber(item, ['position_change', '仓差']) ?? null };
  });
  return rows.some(row => row === null) ? undefined : rows as BridgeTrade[];
};

const normaliseCandleSeries = (raw: unknown): BridgeCandleSeries[] | undefined => {
  if (!Array.isArray(raw)) return undefined;
  const series: BridgeCandleSeries[] = [];
  let totalRows = 0;
  for (const item of raw) {
    if (!isRecord(item)) return undefined;
    const interval = aliasedText(item, ['interval', 'period', '周期'], 24);
    const rowsRaw = firstValue(item, ['rows', 'candles', 'data', '数据']);
    if (!interval || !Array.isArray(rowsRaw)) return undefined;
    if (rowsRaw.length > MAX_CANDLE_ROWS || totalRows + rowsRaw.length > MAX_CANDLE_ROWS) return undefined;
    const rows = rowsRaw.map(row => {
      if (!isRecord(row)) return null;
      const time = aliasedText(row, ['time', 'timestamp', '日期', '时间'], 80);
      const open = aliasedNumber(row, ['open', '开盘']);
      const high = aliasedNumber(row, ['high', '最高']);
      const low = aliasedNumber(row, ['low', '最低']);
      const close = aliasedNumber(row, ['close', '收盘']);
      if (!time || !validTimestamp(time) || open === undefined || open === null || high === undefined || high === null || low === undefined || low === null || close === undefined || close === null) return null;
      return { time, open, high, low, close, volume: aliasedNumber(row, ['volume', '成交量']) ?? null, open_interest: aliasedNumber(row, ['open_interest', '持仓量']) ?? null };
    });
    if (rows.some(row => row === null)) return undefined;
    totalRows += rows.length;
    const asOf = aliasedText(item, ['as_of', 'updated_at', 'timestamp', '数据时间'], 80);
    if (asOf && !validTimestamp(asOf)) return undefined;
    series.push({ interval, rows: rows as BridgeCandle[], as_of: asOf });
  }
  return series;
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

export const deriveAccountBridgeMarketStrategy = (quote: BridgeQuote | undefined, status: AccountBridgeStatus): string => {
  if (!quote || (status !== 'ok' && status !== 'partial')) return '等待有效的东方财富报价与时间戳；不对缺失行情给出方向结论。';
  if (quote.latest === null) return '最新价缺失，先恢复连续报价；不追单、不自动下单。';
  const changePct = quote.change_pct;
  const spread = quote.bid1 !== null && quote.ask1 !== null ? Math.max(0, quote.ask1 - quote.bid1) : null;
  const intradayRange = quote.high !== null && quote.low !== null ? Math.max(0, quote.high - quote.low) : null;
  if (changePct !== null && changePct >= 1.2) return `盘中强势（涨幅 ${changePct.toFixed(2)}%）；只观察回撤承接，确认成交量与止损后再评估，禁止追高。`;
  if (changePct !== null && changePct <= -1.2) return `盘中偏弱（跌幅 ${changePct.toFixed(2)}%）；等待止跌或反抽失败确认，未确认前不抄底。`;
  if (spread !== null && quote.latest > 0 && spread / quote.latest > 0.001) return '买卖价差偏宽；优先等待流动性恢复，策略信号降级为观察。';
  if (intradayRange !== null && quote.latest > 0 && intradayRange / quote.latest > 0.025) return '日内波动较大；采用更小仓位与更宽的验证窗口，先保护保证金。';
  return '价格处于震荡区间；等待多周期方向一致、成交量确认和明确失效位后再评估，不自动下单。';
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
  const quoteRaw = firstValue(raw, ['quote', 'market', '行情', '行情快照']);
  const quote = quoteRaw === undefined ? undefined : normaliseQuote(quoteRaw, asOf);
  if (quoteRaw !== undefined && !quote) return { ok: false, message: 'quote 字段缺少有效合约、报价或时间戳' };
  const depthRaw = firstValue(raw, ['order_book', 'depth', '盘口']);
  const orderBook = depthRaw === undefined ? undefined : normaliseDepth(depthRaw, asOf);
  if (depthRaw !== undefined && !orderBook) return { ok: false, message: 'order_book 字段包含无效盘口数字或时间戳' };
  const tradesRaw = firstValue(raw, ['trades', 'ticks', '分时成交', '逐笔']);
  const trades = tradesRaw === undefined ? undefined : normaliseTrades(tradesRaw);
  if (tradesRaw !== undefined && !trades) return { ok: false, message: 'trades 字段包含无效成交时间或数字' };
  const candleRaw = firstValue(raw, ['candle_series', 'candles_by_interval', '多周期K线']);
  const candleSeries = candleRaw === undefined ? undefined : normaliseCandleSeries(candleRaw);
  if (candleRaw !== undefined && !candleSeries) return { ok: false, message: 'candle_series 字段包含无效周期或 OHLC 数据' };
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
    quote,
    order_book: orderBook,
    trades,
    candle_series: candleSeries,
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
