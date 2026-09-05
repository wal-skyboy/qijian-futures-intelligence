import { json } from '../../lib/market.js';

const assetNames = { gold: '黄金', silver: '白银', copper: '铜', tin: '锡', crude: '原油', usd: '美元' };
const MAX_ITEMS = 6;
const MAX_INLINE_BYTES = 15 * 1024 * 1024;

const responseSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          index: { type: 'integer' },
          file_name: { type: 'string' },
          title: { type: 'string' },
          conclusion: { type: 'string' },
          facts: { type: 'array', items: { type: 'string' } },
          signals: { type: 'array', items: { type: 'string' } },
          scenarios: { type: 'array', items: { type: 'string' } },
          risks: { type: 'array', items: { type: 'string' } },
          missing_data: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'number' },
          next: { type: 'string' },
        },
        required: ['index', 'file_name', 'title', 'conclusion', 'facts', 'signals', 'scenarios', 'risks', 'missing_data', 'confidence', 'next'],
      },
    },
  },
  required: ['items'],
};

function noStore(extra = {}) {
  return { 'Cache-Control': 'no-store', ...extra };
}
function getEnv(env, ...names) {
  for (const name of names) {
    const value = env?.[name];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return '';
}

function cleanText(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function cleanList(value, fallback = []) {
  if (!Array.isArray(value)) return fallback;
  return value.map((item) => cleanText(item)).filter(Boolean).slice(0, 12);
}

function clampConfidence(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : 0;
}

function extractOutputText(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) return payload.output_text;
  const parts = [];
  for (const item of payload?.output || []) {
    for (const part of item?.content || []) {
      if (typeof part?.text === 'string') parts.push(part.text);
    }
  }
  return parts.join('\n');
}

function parseModelJson(text) {
  const fence = String.fromCharCode(96).repeat(3);
  const cleaned = String(text || '').trim().replace(new RegExp('^' + fence + '(?:json)?\\s*', 'i'), '').replace(new RegExp('\\s*' + fence + '$'), '');
  if (!cleaned) throw new Error('视觉模型未返回文本');
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error('视觉模型返回的结果不是有效 JSON');
  }
}

function imageContent(item) {
  const dataUrl = cleanText(item?.data_url);
  const url = cleanText(item?.url);
  if (dataUrl.startsWith('data:image/')) {
    if (dataUrl.length > MAX_INLINE_BYTES * 2) throw new Error((item.file_name || '图片') + '超过请求大小限制');
    return { type: 'input_image', image_url: dataUrl, detail: 'high' };
  }
  if (url.startsWith('https://') || url.startsWith('http://')) return { type: 'input_image', image_url: url, detail: 'high' };
  throw new Error((item.file_name || '图片') + '缺少图片内容，请重新选择文件或填写图片网址');
}

function fileContent(item) {
  const data = cleanText(item?.file_data);
  if (!data) throw new Error((item.file_name || '文件') + '缺少文件内容，请重新选择后提交');
  if (data.length > MAX_INLINE_BYTES * 2) throw new Error((item.file_name || '文件') + '超过请求大小限制');
  return { type: 'input_file', filename: item.file_name || 'upload', file_data: data };
}

function buildPrompt(asset, items) {
  const names = items.map((item, index) => (index + 1) + '. ' + (item.file_name || ('文件 ' + (index + 1))) + ' (' + (item.kind || 'image') + ')').join('\n');
  return '你是严谨、客观、可审计的期货与市场图表审阅员。当前分析品种是“' + asset + '”。下面会提供一个或多个用户上传的图片、报告或网址，请严格按编号分别分析。\n\n'
    + '输入清单：\n' + names + '\n\n'
    + '只依据输入中可见或可读取的证据，不要补猜看不清的价格、时间、合约、指标、新闻或概率。请输出 JSON，items 数组与输入顺序一一对应，每项包含：\n'
    + '- index、file_name、title\n'
    + '- conclusion：先给客观结论，再明确这是事实还是推断\n'
    + '- facts：OCR/图表中可直接确认的价格、单位/币种、时间、周期、合约、数值和标注；看不清就写“无法确认”\n'
    + '- signals：只在图中确实可见时描述趋势、结构、支撑阻力、成交量、持仓量、指标、背离和形态，并说明依据\n'
    + '- scenarios：给出上涨/震荡/下跌等条件情景和触发条件，不提供保证性胜率\n'
    + '- risks：反证、数据延迟/样本局限、可能导致判断失效的因素\n'
    + '- missing_data：图中缺失或无法核验的关键数据\n'
    + '- confidence：0-100 的证据置信度，不是盈利概率\n'
    + '- next：下一步需要核验的公开数据或应观察的价格条件\n\n'
    + '若输入不是图表或内容不可读，明确说明无法从该输入推断方向。必须区分“图片可见事实”和“分析推断”，不得生成投资建议、确定性收益或 99% 胜率。所有时间若能识别请保留原时区；不要把美元、人民币、指数点或合约报价混为一谈。';
}

async function callOpenAI(key, model, input) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        store: false,
        max_output_tokens: 2200,
        input: [{ role: 'user', content: input }],
        text: { format: { type: 'json_schema', name: 'futures_image_analysis', strict: true, schema: responseSchema } },
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload?.error?.message || ('视觉模型返回 HTTP ' + response.status);
      throw new Error(message);
    }
    return parseModelJson(extractOutputText(payload));
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('视觉模型请求超时（25 秒），请减少文件数量或稍后重试');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeResult(raw, item, index, receivedAt, provider, mode, asset) {
  return {
    id: item.id || ('analysis-' + (index + 1)),
    kind: item.kind || 'image',
    file_name: cleanText(raw?.file_name, item.file_name || ('文件 ' + (index + 1))),
    provider,
    mode,
    received: true,
    analysis_status: 'complete',
    received_at: receivedAt,
    title: cleanText(raw?.title, asset + ' 图片深度分析'),
    conclusion: cleanText(raw?.conclusion, '视觉模型未给出可确认结论，请检查输入清晰度。'),
    facts: cleanList(raw?.facts),
    signals: cleanList(raw?.signals),
    scenarios: cleanList(raw?.scenarios),
    risks: cleanList(raw?.risks),
    missing_data: cleanList(raw?.missing_data),
    confidence: clampConfidence(raw?.confidence),
    next: cleanText(raw?.next, '补充清晰的周期、合约、币种、成交量和持仓量后再核验。'),
  };
}

export async function onRequestPost({ request, env }) {
  let payload = {};
  try {
    payload = await request.json();
  } catch {
    return json({ status: 'error', analysis_status: 'invalid_request', error: '请求格式错误' }, 400, noStore());
  }

  const key = getEnv(env, 'OPENAI_API_KEY', 'VISION_API_KEY', 'openai_api_key', 'vision_api_key');
  if (!key) {
    return json({
      status: 'error', provider: 'openai_vision', mode: '真实视觉分析未配置', received: false,
      analysis_status: 'not_configured', error: '未配置 OPENAI_API_KEY（或 VISION_API_KEY），未生成演示分析。请在 EdgeOne 生产环境变量中配置后重新部署。',
    }, 503, noStore());
  }

  const rawItems = Array.isArray(payload.items) && payload.items.length ? payload.items : [payload];
  const items = rawItems.filter((item) => item && typeof item === 'object').slice(0, MAX_ITEMS);
  if (!items.length) return json({ status: 'error', analysis_status: 'invalid_request', error: '请至少提交一项图片、文件或网址' }, 400, noStore());

  const asset = assetNames[payload.asset] || cleanText(payload.asset, '当前品种');
  const content = [{ type: 'input_text', text: buildPrompt(asset, items) }];
  try {
    for (const item of items) {
      if (item.kind === 'file') content.push(fileContent(item));
      else content.push(imageContent(item));
    }
  } catch (error) {
    return json({ status: 'error', provider: 'openai_vision', analysis_status: 'invalid_input', error: error.message || '提交内容无效' }, 400, noStore());
  }

  const model = getEnv(env, 'OPENAI_VISION_MODEL', 'VISION_MODEL') || 'gpt-4o';
  const provider = 'openai_vision';
  const mode = '真实视觉分析（' + model + '）';
  try {
    const modelPayload = await callOpenAI(key, model, content);
    const receivedAt = new Date().toISOString();
    const modelItems = Array.isArray(modelPayload?.items) ? modelPayload.items : [];
    const results = items.map((item, index) => {
      const raw = modelItems.find((candidate) => Number(candidate?.index) === index) || modelItems[index] || {};
      return normalizeResult(raw, item, index, receivedAt, provider, mode, asset);
    });
    return json({ status: 'ok', provider, mode, received: true, analysis_status: 'complete', received_at: receivedAt, count: results.length, items: results }, 200, noStore());
  } catch (error) {
    return json({ status: 'error', provider, mode: '真实视觉分析失败', received: false, analysis_status: 'provider_error', error: error.message || '视觉模型请求失败' }, 502, noStore());
  }
}
