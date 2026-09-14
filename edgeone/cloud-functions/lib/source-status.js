/**
 * Server-side readiness for the data paths documented by the dashboard.
 *
 * This endpoint deliberately reports configuration state only.  It never
 * returns a token, account, password, host, or a guessed provider URL.  The
 * actual provider calls remain in their existing adapters so a missing or
 * expired entitlement still fails closed with an explicit data label.
 */

const SHFE_DELAYED_URL = 'https://www.shfe.com.cn/data/tradedata/future/delaymarket/delaymarket_all.dat';

const EXCHANGE_LINKS = [
  { name: '上期所 SHFE', scope: '沪金 / 沪银 / 沪铜 / 沪锡 / 原油', url: 'https://www.shfe.com.cn/', status: 'ready', message: '公开延时 JSON 已接入，按 60 秒轮询。' },
  { name: '大商所 DCE', scope: '铁矿石 / 豆粕 / 棕榈油等', url: 'https://www.dce.com.cn/', status: 'needs_authorization', message: '等待交易所或授权分销商提供允许公开的延时接口。' },
  { name: '郑商所 CZCE', scope: '白糖 / 棉花 / PTA 等', url: 'https://www.czce.com.cn/', status: 'needs_authorization', message: '等待交易所或授权分销商提供允许公开的延时接口。' },
  { name: '中金所 CFFEX', scope: '股指 / 国债期货', url: 'https://www.cffex.com.cn/', status: 'needs_authorization', message: '等待交易所或授权分销商提供允许公开的延时接口。' },
  { name: '广期所 GFEX', scope: '工业硅 / 碳酸锂等', url: 'https://www.gfex.com.cn/', status: 'needs_authorization', message: '等待交易所或授权分销商提供允许公开的延时接口。' },
];

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
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

function configuredStatus(configured, configuredLabel, missingLabel) {
  return configured
    ? { status: 'configured', status_label: configuredLabel }
    : { status: 'needs_setup', status_label: missingLabel };
}

/**
 * Return a safe, user-facing checklist for the four supported paths:
 * SimNow simulation, public exchange delay, authorised data APIs, and the
 * production CTP bridge.  `env` is intentionally kept generic for both
 * EdgeOne Functions and the local FastAPI-compatible runtime.
 */
export function sourceReadiness(env = {}) {
  const bridgeUrl = envValue(env, ['CTP_BRIDGE_URL']);
  const bridgeToken = envValue(env, ['CTP_BRIDGE_TOKEN']);
  const bridgeHttps = isHttps(bridgeUrl);
  const bridgeConfigured = bridgeHttps && Boolean(bridgeToken);
  const thsToken = envValue(env, ['THS_IFIND_ACCESS_TOKEN', 'THS_ACCESS_TOKEN']);
  const thsEndpoint = envValue(env, ['THS_IFIND_API_URL']);
  const choiceToken = envValue(env, ['EASTMONEY_CHOICE_TOKEN', 'CHOICE_ACCESS_TOKEN']);
  const choiceEndpoint = envValue(env, ['EASTMONEY_CHOICE_API_URL']);

  const simnowConfig = configuredStatus(
    bridgeConfigured,
    'Bridge 地址与服务端令牌已配置',
    '需要本机 Bridge、HTTPS 地址和令牌',
  );
  const productionConfig = configuredStatus(
    bridgeConfigured,
    '生产 Bridge 通道已配置，仍需经纪商上线认证',
    '需要经纪商生产前置、生产 SDK 和 Bridge',
  );
  const thsConfig = configuredStatus(
    Boolean(thsToken),
    '令牌已配置，正在按请求校验接口字段',
    '需要 iFinD 官方账号令牌',
  );
  const choiceConfig = choiceToken && !choiceEndpoint
    ? { status: 'needs_setup', status_label: '缺少官方 API 地址', message: 'Choice 需要同时配置合同提供的 HTTPS API 地址；开发版流量额度不代表期货实时快照权限。' }
    : configuredStatus(
      Boolean(choiceToken && choiceEndpoint),
      '令牌和 API 地址已配置，仍需校验实时权限',
      '需要 Choice 官方账号令牌与 API 地址',
    );

  const thsStatus = thsConfig.status === 'configured' && thsEndpoint && !isHttps(thsEndpoint)
    ? { status: 'error', status_label: '接口地址必须为 HTTPS', message: '请改用 iFinD 官方授权 HTTPS API 地址。' }
    : thsConfig;
  const choiceStatus = choiceConfig.status === 'configured' && choiceEndpoint && !isHttps(choiceEndpoint)
    ? { status: 'error', status_label: '接口地址必须为 HTTPS', message: '请改用 Choice 合同提供的 HTTPS API 地址。' }
    : choiceConfig;

  const steps = [
    {
      id: 'simnow', order: 1, name: 'SimNow 仿真 CTP', category: '免费仿真', ...simnowConfig,
      message: bridgeConfigured ? '可由私有版检查 Bridge /health 与最新 Tick。' : '先注册 SimNow、填写本机 CTP Bridge，再回到私有版刷新。',
      next_step: bridgeConfigured ? '在私有版登录后刷新 CTP 行情' : '注册 SimNow → 填写 backend/simnow.env → 启动 Bridge',
      docs_url: 'https://www.simnow.com.cn/static/apiDownload.action',
      public_url: 'https://www.simnow.com.cn/product.action',
      safe_configured: bridgeConfigured,
    },
    {
      id: 'exchange_public', order: 2, name: '交易所公开延时', category: '无 Key · 官方公开', status: 'ready', status_label: '上期所已接入',
      message: '上期所 SHFE 延时 JSON 默认启用；其他交易所仅在取得公开/授权 Feed 后接入。',
      next_step: '先查看公开版国内延时；取得 DCE/CZCE/CFFEX/GFEX Feed 后再配置',
      docs_url: 'https://www.shfe.com.cn/reports/marketdata/delayedquotes/',
      public_url: SHFE_DELAYED_URL,
      safe_configured: true,
      exchanges: EXCHANGE_LINKS,
    },
    {
      id: 'authorised_apis', order: 3, name: 'iFinD × Choice 授权 API', category: '试用/授权',
      status: thsStatus.status === 'configured' && choiceStatus.status === 'configured'
        ? 'configured'
        : thsStatus.status === 'configured' || choiceStatus.status === 'configured'
          ? 'partial'
          : thsStatus.status === 'error' || choiceStatus.status === 'error'
            ? 'error'
            : 'needs_setup',
      status_label: thsStatus.status === 'configured' && choiceStatus.status === 'configured' ? '双源已配置' : thsStatus.status === 'configured' || choiceStatus.status === 'configured' ? '已配置一源' : '等待授权',
      message: `同花顺：${thsStatus.status_label}；东方财富：${choiceStatus.status_label}。`,
      next_step: '在服务端填入对应令牌和官方 HTTPS API 地址，刷新“同花顺 × Choice”区块',
      docs_url: 'https://quantapi.51ifind.com/gwstatic/static/ds_web/quantapi-web/help-center/manual.html',
      public_url: 'https://choice.eastmoney.com/product/datacenter',
      safe_configured: thsStatus.status === 'configured' || choiceStatus.status === 'configured',
      providers: [
        { id: 'ths_ifind', name: '同花顺 iFinD', status: thsStatus.status, status_label: thsStatus.status_label, docs_url: 'https://quantapi.51ifind.com/gwstatic/static/ds_web/quantapi-web/help-center/manual.html' },
        { id: 'eastmoney_choice', name: '东方财富 Choice', status: choiceStatus.status, status_label: choiceStatus.status_label, docs_url: 'https://quantapi.eastmoney.com/' },
      ],
    },
    {
      id: 'ctp_production', order: 4, name: 'CTP 生产 Bridge', category: '本人授权实盘', ...productionConfig,
      message: bridgeConfigured ? '线上通道已配置；仍以期货公司生产认证和看穿式要求为准。' : '生产前置、BrokerID、账号和看穿式认证必须由期货公司下发。',
      next_step: bridgeConfigured ? '在受信 x86_64 主机完成生产 SDK /health，再登录私有版' : '向期货公司申请生产前置 → 部署官方 SDK sidecar → 配置 Bridge',
      docs_url: 'https://gjqh.com.cn/ws-2003417-c0003-cn/list_5692.shtml',
      public_url: 'https://www.simnow.com.cn/static/apiDownload.action',
      safe_configured: bridgeConfigured,
    },
  ];

  const configuredCount = steps.filter((step) => ['ready', 'configured', 'partial'].includes(step.status)).length;
  const needsAuthorization = steps.filter((step) => ['needs_authorization', 'needs_setup', 'error'].includes(step.status)).length;
  return {
    status: configuredCount === steps.length ? 'ready' : configuredCount > 0 ? 'partial' : 'waiting',
    as_of: new Date().toISOString(),
    summary: { completed: configuredCount, total: steps.length, needs_authorization: needsAuthorization },
    steps,
    policy: {
      note: '状态接口只返回是否配置，不返回任何密钥、账号、密码或完整前置地址。真实行情仍按每个 Provider 的时效和许可标签展示。',
      blocked_methods: ['网页抓取', 'Cookie/登录态读取', '逆向终端协议', '未授权转载', '自动下单'],
    },
  };
}

export { EXCHANGE_LINKS };
