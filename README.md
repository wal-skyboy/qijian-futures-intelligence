# 期鉴 · 期货情报与策略平台

中文专业交易终端风格的可部署 MVP。前端为 React/TypeScript，API 为 FastAPI；重点品种固定为黄金、白银、铜、锡、原油、美元，其他已支持品种可在顶部搜索后复用同一套资讯、风险与策略视图。

顶部品种搜索支持黄金、白银、铜、锡、原油、美元、大豆、玉米和螺纹钢；切换品种后，行情、事件、利多/利空、日历、风险、策略和图片分析上下文会同步切换。侧栏和跨品种速览只展示前六个重点品种，其他品种通过搜索进入，未接入专属资讯流的品种会显示明确的通用模板与 Provider 待接入状态。实盘交易看板以一次同步时间展示六个重点品种，列出来源、延迟和实时/日频/授权/演示状态，并用 15 秒服务端缓存保护免费接口。

## 本地运行

前端：`npm install && npm run dev`。API：进入 `backend`，安装 requirements 后运行 `uvicorn app.main:app --reload`。生产整套服务可复制 `.env.example` 为 `.env` 后运行 `docker compose up -d --build`。

## 免费数据组合（当前默认）

默认 `MARKET_PROVIDER=free`：GDELT 新闻（`/api/v1/news/{symbol}`）、FRED 宏观（`/api/v1/macro`）、CFTC COT（`/api/v1/cot/{contract}`）和 Alpha Vantage 市场适配器（`/api/v1/market/{symbol}`）。配置免费 Alpha Vantage Key 后，黄金/白银使用官方文档标注的 live spot，美元使用 USD/CNY 外汇实时汇率，铜与 WTI 使用日频参考；锡仍明确标为需要交易所授权。没有 Key 或 Provider 失败时返回带 `data_mode` 的明确回退状态，绝不把 Demo 数值伪装成实时交易所价格。

## 公开版与私有版

页面现在明确分为两条数据路径：

- **公开版**：国际黄金/白银现货与 USD/CNY 外汇在免费 Provider 明确返回实时值时标为“免费现货实时/免费外汇实时”；国内沪金、沪银、沪铜、沪锡、原油单独通过 `/api/v1/public/domestic-delayed` 展示“官方延时行情”。未配置授权延时接口时只显示“官方延时 · 待接入”和官方来源链接，不显示伪造价格。
- **私有版**：`/api/v1/private/session` 提供 HttpOnly、Secure、8 小时会话；`/api/v1/private/ctp/board` 只向已登录的本人会话返回 CTP Bridge 数据。EdgeOne Pages 函数不能直接维持期货公司 CTP 的 TCP 长连接，因此需在中国大陆自有主机或受信网络部署一个只服务本人的 Bridge，再把 HTTPS 地址填入 `CTP_BRIDGE_URL`。未配置 Bridge 时接口返回“CTP Bridge 未配置”，不会把旧数据标成实时。

公开版和私有版均返回 `data_mode`、`provider`、`as_of`、`delayed`、`source_url`、`note` 等字段；前端以这些字段渲染标签，便于核验和审计。公开页面不接受 CTP 凭据，也不输出私有盘口。

实时交易看板下方提供 K 线视图，前端调用同域 `/api/v1/market/candles?symbol={symbol}&interval=daily|weekly|monthly`。EdgeOne 函数优先使用 Alpha Vantage 的 `GOLD_SILVER_HISTORY`、`FX_DAILY`、`WTI`、`COPPER` 历史接口，并在黄金/白银/美元上将最新免费现货/外汇报价标在最后一根；历史源只返回收盘价时，页面会明确写出 OHLC 为结构合成，不把它标成交易所实时期货 K 线。K 线服务端缓存 60 秒，适配免费额度；铜/原油为日频或更低频参考，锡保持“交易所授权待接入”。

配置 `.env`：

```env
MARKET_PROVIDER=free
NEWS_PROVIDER=gdelt
ALPHAVANTAGE_API_KEY=
FRED_API_KEY=
CFTC_APP_TOKEN=
DOMESTIC_DELAYED_URL=
DOMESTIC_DELAYED_TOKEN=
PRIVATE_ACCESS_CODE=
CTP_BRIDGE_URL=
CTP_BRIDGE_TOKEN=
VISION_PROVIDER=demo
VISION_API_KEY=
```

GDELT 不需 Key；CFTC 公共 PRE 低频访问通常不需 Token；FRED 需要免费账户 Key；Alpha Vantage 免费 Key 适合低频现货/历史查询。免费组合适合个人研究、延迟行情和资讯筛选，不提供 CME/COMEX/LME 的无限制实时 Tick、盘口或商业新闻再分发授权。生产公开服务前仍需核对各来源条款，并在需要时替换为持牌行情 Provider。

“实时”只对 Provider 明确支持的现货或外汇报价使用；交易所级期货 Tick、盘口和公开再分发通常需要 CME、LME、SHFE 等交易所或其授权分销商许可。页面会同时显示 `data_mode`、来源和时间戳，便于审计。

国内期货延时适配器约定：`DOMESTIC_DELAYED_URL` 返回 JSON 数组或 `{items:[...]}`，每行至少包含 `symbol`（`au/ag/cu/sn/sc` 之一）、`price`、`change_pct`、`as_of`；可选 `contract`、`high`、`low`、`open`、`volume`、`open_interest`、`source_url`。服务端会白名单归一化字段，并将其标为 `official_delayed`。请只接入交易所或授权分销商允许公开展示的延时数据。

CTP Bridge 约定：`CTP_BRIDGE_URL` 返回 `{items:[{symbol,name,contract,last,bid,ask,change_pct,volume,open_interest,as_of}],as_of,latency_ms}`；可用 `CTP_BRIDGE_TOKEN` 做服务端 Bearer 校验。Bridge 应自行使用期货公司提供的 CTP SDK/柜台连接，平台只接收已归一化的行情，不保存交易密码、不提供自动下单。

## 金银比与图片辅助分析

前端会用黄金/白银报价计算金银比，并结合美元、实际利率、库存和 CFTC 净持仓给出相对强弱解读；金银比只作为组合风格过滤器，不单独触发交易。图片分析支持 PNG/JPG/WebP，浏览器先做 8MB 校验、拖拽/选择后的本地预览和尺寸校验，再自动调用 `/api/v1/image-analysis`；服务不可用时会明确显示离线演示结果或错误原因，不再出现空白状态。默认 `VISION_PROVIDER=demo` 返回结构化的演示分析；接入生产视觉模型时，只需替换该 Provider，上传组件和返回字段保持不变。

## 上线到自有域名

1. 将域名 A/AAAA 记录指向服务器；将 `deploy/nginx.conf` 的 `server_name` 改成真实域名。
2. 用 Certbot 或云负载均衡申请并自动续期 TLS 证书；推荐先仅开放 80/443。
3. 设置强随机数据库密码、限定 CORS 域名、以 secrets 注入 API 密钥，不提交 `.env`。
4. 启动后检查 `/health`，并为 API 错误率、数据延迟、Provider 失败、刷新耗时和磁盘备份配置告警。

### EdgeOne Pages 静态部署

仓库内的 `edgeone/` 是专为 EdgeOne Pages 准备的纯 React/Vite 静态入口。这样可以避免平台把包含 Vinext/Next 开发文件的根目录误判为 OpenNext 全栈项目。

在 EdgeOne 项目设置中将“根目录”设为 `/edgeone`，框架预设选“React”，编译命令为 `npm run build`，输出目录为 `build`，安装命令为 `npm install`，Node.js 选 `22.17.1`。保存后在“构建部署”中重新部署 `main` 分支。生产域名 `emcdb.com` 保持现有自定义域名和 CNAME，不需要重新配置 DNS。

EdgeOne Pages 负责静态前端；仓库同时提供 `edgeone/cloud-functions/` 同域 API（`/api/v1/market/board`、`/api/v1/market/{symbol}`、`/api/v1/market/candles?symbol=...`、`/api/v1/image-analysis`），部署成功后无需跨域配置，前端默认直接调用当前域名。要启用免费源，在 EdgeOne 项目环境变量增加 `ALPHAVANTAGE_API_KEY`（只放服务端）；未设置时接口仍返回可审计的演示/授权待接入状态，不会伪装成实盘。若使用更完整的 FastAPI 服务，则可继续把 `backend/` 作为独立 API 运行，并在前端环境变量加入 `NEXT_PUBLIC_API_URL=https://你的-api-域名` 后重新部署。现货/外汇源没有可比昨收时，涨跌幅显示为“—”，避免把演示涨跌幅混入实时价格。

## 已实现的质量优化

本轮质量门展示 40 项检查：Provider 可替换、去重状态反馈、来源分级、事件影响评分、时效时间戳、置信度校准、观点版本化、增删/多空/策略 diff、宏观与技术面融合、成交量/OI、波动率与金银比、事件窗口、七日策略、仓位上限、止损、催化剂、风险清单、数据新鲜度、刷新去抖、缓存扩展点、移动端折叠、深色对比度、键盘焦点、错误恢复、API 健康检查、安全响应头、SEO、可观测性、提醒开关、时区明确、紧凑模式、来源健康、过期防护等。

能力基准参考了 TradingView 的多品种/观察列表提醒和经济日历、CME 的成交量与持仓工具、Bloomberg 的新闻与组合风险工作流；界面中的“质量门”会逐项展示这些检查项。

> Demo 数值与事件仅用于产品演示，不构成投资建议。
