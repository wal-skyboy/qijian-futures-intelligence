import { json } from '../../lib/market.js';

const assetNames = { gold: '黄金', silver: '白银', copper: '铜', tin: '锡', crude: '原油', usd: '美元' };

function analysisFor(meta = {}, asset, index = 0) {
  const name = String(meta.file_name || (meta.kind === 'url' ? '网址' : `文件 ${index + 1}`));
  const dimensions = meta.width && meta.height ? `（${meta.width}×${meta.height}）` : '';
  const kindLabel = meta.kind === 'url' ? '网址' : meta.kind === 'file' ? '文件' : '图片';
  return {
    id: meta.id || `analysis-${index + 1}`,
    kind: meta.kind || 'image',
    file_name: name,
    provider: 'demo_vision',
    mode: '演示分析',
    received: true,
    analysis_status: 'demo',
    received_at: new Date().toISOString(),
    title: `${asset} ${kindLabel}结构已读取`,
    conclusion: `已接收 ${name}${dimensions}，当前 ${asset} 研判仍需结合价格、成交量、持仓和事件窗口交叉验证。`,
    signals: ['识别趋势线、支撑阻力与突破形态', '检查图表周期、合约月份和时间戳', '对照金银比 / 宏观数据确认是否背离'],
    next: '当前为演示视觉结果；接入生产视觉模型后可返回 OCR、K 线形态、关键价位和图中标注解释。',
  };
}

export async function onRequestPost({ request }) {
  let payload = {};
  try {
    payload = await request.json();
  } catch {
    return json({ detail: '请求格式错误' }, 400);
  }
  const asset = assetNames[payload.asset] || payload.asset || '当前品种';
  const items = Array.isArray(payload.items) ? payload.items.filter((item) => item && typeof item === 'object').slice(0, 6) : [];
  if (items.length) {
    const receivedAt = new Date().toISOString();
    return json({
      provider: 'demo_vision',
      mode: '演示分析',
      received: true,
      analysis_status: 'demo',
      received_at: receivedAt,
      count: items.length,
      items: items.map((item, index) => ({ ...analysisFor(item, asset, index), received_at: receivedAt })),
    });
  }
  return json(analysisFor(payload, asset));
}
