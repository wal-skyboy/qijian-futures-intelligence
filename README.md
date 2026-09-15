# 期鉴 · 期货情报与策略平台

校准发布记录：当前版本对无密钥、Provider 异常和全球事件源超时统一返回待核验状态，不沿用旧报价或旧资讯；国际报价、国内官方延时和私有 CTP 数据继续按各自授权与时效标签分开显示。

中文专业交易终端风格的可部署 MVP。前端为 React/TypeScript，API 为 FastAPI；重点品种固定为黄金、白银、铜、锡、原油、美元，其他已支持品种可在顶部搜索后复用同一套资讯、风险与策略视图。

顶部品种搜索支持黄金、白银、铜、锡、原油、美元、大豆、玉米和螺纹钢；切换品种后，行情、事件、利多/利空、日历、风险、策略和图片分析上下文会同步切换。侧栏和跨品种速览只展示前六个重点品种，其他品种通过搜索进入，未接入专属资讯流的品种会显示明确的通用模板与 Provider 待接入状态。实盘交易看板以一次同步时间展示六个重点品种，列出来源、延迟和实时/日频/授权/演示状态，并用 15 秒服务端缓存保护免费接口。

## 本地运行

前端：`npm install && npm run dev`。API：进入 `backend`，安装 requirements 后运行 `uvicorn app.main:app --reload`。生产整套服务可复制 `.env.example` 为 `.env` 后运行 `docker compose up -d --build`。

## 免费数据组合（当前默认）

默认 `MARKET_PROVIDER=free`：GDELT 新闻（`/api/v1/news/{symbol}`、`/api/v1/events`）、FRED 宏观（`/api/v1/macro`）、CFTC COT（`/api/v1/cot/{contract}`）和 Alpha Vantage 市场适配器（`/api/v1/market/{symbol}`）。`/api/v1/events` 默认同时轮询 GDELT 与 Google News 的过去 7 天历史窗口，并接入一个带来源标识的公开经济日历（[公开日历源](https://nfs.faireconomy.media/ff_calendar_thisweek.json)）覆盖未来 7 天；配置 `GLOBAL_CALENDAR_URL` 后可切换到官方/授权 JSON 或 RSS 日历。历史事件按来源、标题和时间去重，未来事件按高/中影响过滤，并全部归一化北京时间、品种、多空、影响、置信度和原文链接。日历适配器兼容完整 ISO 时间戳及“日期 + 时间”分栏格式，并将无具体时刻的全天事件保留到当天结束，避免当天早晨被误判为过期。历史新闻缓存 60 秒，公开日历单独缓存 5 分钟以避免过度请求；前端事件源单独每 5 分钟轮询，切回页面或点击“立即更新”也会刷新。页面明确区分“公开经济日历”和“授权日历”，显示来源、抓取时间、可用性、条目数、错误状态与下次刷新时间；源失败或没有可核验高影响事件时只显示状态提示和重试入口，不再用旧的静态事件卡片冒充实时日历。配置免费 Alpha Vantage Key 后，黄金/白银使用官方文档标注的 live spot，美元使用 USD/CNY 外汇实时汇率，铜与 WTI 使用日频参考；锡仍明确标为需要交易所授权。没有 Key 或 Provider 失败时返回带 `data_mode` 的明确回退状态，绝不把 Demo 数值伪装成实时交易所价格。

## 公开版与私有版

页面现在明确分为两条数据路径：

- **公开版**：国际黄金/白银现货与 USD/CNY 外汇在免费 Provider 明确返回实时值时标为“免费现货实时/免费外汇实时”；国内沪金、沪银、沪铜、沪锡、原油单独通过 `/api/v1/public/domestic-delayed` 读取上期所官网公开延时 JSON，展示“官方延时行情”。该源无 API Key、约 60 秒刷新，字段包含合约、最新价、涨跌、开高低、成交量、持仓、买卖一档（以官网实际返回为准）。若配置了授权分销商 URL，则覆盖默认官网源并标注为授权 Provider；任何情况下都不把延时数据标为实时。
- **私有版**：`/api/v1/private/session` 提供 HttpOnly、Secure、8 小时会话；`/api/v1/private/ctp/board` 只向已登录的本人会话返回 CTP Bridge 数据。EdgeOne Pages 函数不能直接维持期货公司 CTP 的 TCP 长连接，因此需在中国大陆自有主机或受信网络部署一个只服务本人的 Bridge，再把 HTTPS 地址填入 `CTP_BRIDGE_URL`。未配置 Bridge 时接口返回“CTP Bridge 未配置”，不会把旧数据标成实时。

公开版和私有版均返回 `data_mode`、`provider`、`as_of`、`delayed`、`source_url`、`note` 等字段；前端以这些字段渲染标签，便于核验和审计。公开页面不接受 CTP 凭据，也不输出私有盘口。

实时交易看板下方提供 K 线视图，前端调用同域 `/api/v1/market/candles?symbol={symbol}&interval=hourly|daily|weekly|monthly|yearly`，图表显示最近蜡烛的北京时间日期刻度、完整更新时间和价格币种。EdgeOne 函数优先使用 Alpha Vantage 的 `GOLD_SILVER_HISTORY`、`FX_DAILY/FX_WEEKLY/FX_MONTHLY`、`WTI`、`COPPER` 历史接口，并在黄金/白银/美元上将最新免费现货/外汇报价标在最后一根；年线由月线按自然年聚合。Alpha Vantage 的商品历史接口公开支持日、周、月，小时级商品历史不在免费接口范围，因此小时选项在未配置持牌 intraday Provider 时会明确标为“需实时源”，只显示合成占位，不冒充实盘 OHLC；铜的免费源为月/季/年频，日/周同样显示待接入。历史源只返回收盘价时，页面会明确写出 OHLC 为结构合成，不把它标成交易所实时期货 K 线。K 线服务端缓存 60 秒，适配免费额度；锡保持“交易所授权待接入”。

K 线交互已按东方财富期货的阅读习惯增强：小时、日、周、月、年可直接切换；横轴按北京时间显示 `MM-DD`、`YYYY-W##`、`YYYY-MM` 或年份；移动鼠标/触控光标会出现十字线、日期和 OHLC/成交量浮窗。黄金现货仍标为 `XAU/USD · USD/oz`；页面另设 `COMEX GC1! · 1金衡盎司 · USD/oz` 独立卡片。只有配置 `COMEX_GOLD_FUTURES_URL`（持牌/授权 JSON）并返回价格后才显示 COMEX 主连数值，未配置或 Provider 异常时不以现货或沪金价格替代。

配置 `.env`：

Sites 生产发布使用默认 `npm run build` 生成带 `fetch` 入口的 Worker；`EDGEONE_BUILD=1` 仅用于旧版 EdgeOne 静态校验，不用于 Sites Worker 发布。

```env
MARKET_PROVIDER=free
NEWS_PROVIDER=gdelt
ALPHAVANTAGE_API_KEY=
FRED_API_KEY=
CFTC_APP_TOKEN=
GLOBAL_EVENTS_URL=
GLOBAL_CALENDAR_URL=
GLOBAL_CALENDAR_NAME=
EVENTS_FETCH_TIMEOUT_MS=8000
CALENDAR_FETCH_TIMEOUT_MS=3500
DOMESTIC_DELAYED_URL=
DOMESTIC_DELAYED_TOKEN=
PRIVATE_ACCESS_CODE=
CTP_BRIDGE_URL=
CTP_BRIDGE_TOKEN=
VISION_PROVIDER=openai
OPENAI_API_KEY=
OPENAI_VISION_MODEL=gpt-4o
VISION_API_KEY=
VISION_TIMEOUT_SECONDS=25
```

GDELT 不需 Key；CFTC 公共 PRE 低频访问通常不需 Token；FRED 需要免费账户 Key；Alpha Vantage 免费 Key 适合低频现货/历史查询。免费组合适合个人研究、延迟行情和资讯筛选，不提供 CME/COMEX/LME 的无限制实时 Tick、盘口或商业新闻再分发授权。生产公开服务前仍需核对各来源条款，并在需要时替换为持牌行情 Provider。

“实时”只对 Provider 明确支持的现货或外汇报价使用；交易所级期货 Tick、盘口和公开再分发通常需要 CME、LME、SHFE 等交易所或其授权分销商许可。页面会同时显示 `data_mode`、来源和时间戳，便于审计。

国内期货延时适配器默认读取上期所公开文件：`https://www.shfe.com.cn/data/tradedata/future/delaymarket/delaymarket_all.dat`，通过 `params` 时间戳参数避免缓存；官网延时说明页为 `https://www.shfe.com.cn/reports/marketdata/delayedquotes/`。该文件是公开、无密钥、延时行情，不含交易所实时 Tick、Level-2 或自动下单权限。服务端按 `instrumentid` 分组，并按持仓量优先选取主力参考合约，白名单归一化 `lastprice`、`upperdown`、`presettlementprice`、`updatetime`、`highprice`、`lowerprice`、`openprice`、`volume`、`openinterest`、`bidprice`、`askprice` 等字段。若接入交易所或授权分销商的 JSON，可设置 `DOMESTIC_DELAYED_URL`（及可选 `DOMESTIC_DELAYED_TOKEN`/`SHFE_DELAYED_API_KEY`）覆盖默认源；每行至少包含 `symbol`（`au/ag/cu/sn/sc` 之一）、`price`、`change_pct`、`as_of`。请只接入允许公开展示的延时数据。

CTP Bridge 约定：`CTP_BRIDGE_URL` 返回 `{items:[{symbol,name,contract,last,bid,ask,change_pct,volume,open_interest,as_of}],as_of,latency_ms}`；可用 `CTP_BRIDGE_TOKEN` 做服务端 Bearer 校验。Bridge 应自行使用期货公司提供的 CTP SDK/柜台连接，平台只接收已归一化的行情，不保存交易密码、不提供自动下单。

### SimNow 仿真方案（先执行）

SimNow 适合先把“CTP 前置 → 本地行情 Bridge → 期鉴私有版”整条链路跑通。SimNow 的 API 下载页是 [simnow.com.cn/static/apiDownload.action](https://www.simnow.com.cn/static/apiDownload.action)；注册并登录后，下载与测试环境、操作系统和架构匹配的 CTP 期货期权 API。API 包本身不提供账号，必须先在 SimNow 申请仿真账号，并以账号页面显示的行情前置、BrokerID、用户号和密码为准；不要把这些值提交到 Git 或填入网页。

仓库提供只读的 `backend/ctp_bridge.py` 适配器。它使用 `openctp-ctp` 的 CTP 行情回调接收 Tick，在内存中保留最近快照，并输出与 EdgeOne 私有接口一致的 `/board` JSON；`/health` 只返回连接、登录、报价新鲜度和配置状态，不返回账号或密码。CTP 是 TCP 长连接，不能由 EdgeOne Pages 直接连接，因此 Bridge 必须运行在本机或中国大陆自有/受信主机上，再由 EdgeOne 服务端通过 HTTPS 读取。

本机首次验证：

1. 在 SimNow 控制台完成仿真账号和行情权限，下载官方 API；保存页面显示的测试行情前置地址。若 SimNow 或期货公司要求客户端认证，同时保存 AppID/AuthCode，并使用与前置匹配的 SDK 版本。
2. 复制 `backend/simnow.env.example` 为本机私有环境文件，填写 `CTP_MD_FRONT`、`CTP_BROKER_ID`、`CTP_USER_ID`、`CTP_PASSWORD` 和实际订阅合约（例如 `au2610,ag2610,cu2610,sn2610,sc2610`，以 SimNow 当日可交易合约为准），生成一串仅用于 Bridge 的 `CTP_BRIDGE_TOKEN`。
3. 在项目根目录安装 `backend/requirements-ctp.txt`，启动 `uvicorn backend.ctp_bridge:app --host 127.0.0.1 --port 8787`。先查看 `http://127.0.0.1:8787/health`，必须看到 `connected: true`、`logged_in: true`，并在交易时段看到 `quote_count` 增加；再用 Bearer 令牌访问 `/board`。未配置、登录失败、订阅失败或超过 5 秒未收到新 Tick 时，Bridge 会返回明确状态并停止输出旧报价。
4. 要让线上私有版读取 Bridge，在 EdgeOne 生产环境设置 `CTP_BRIDGE_URL=https://你的受信域名/board` 和同值 `CTP_BRIDGE_TOKEN`，保存并重新部署；然后在期鉴“本人 CTP 私有版”输入已有的 `PRIVATE_ACCESS_CODE`，点击“刷新 CTP 行情”。公网只暴露 HTTPS 反向代理，Bridge 端启用防火墙白名单、TLS、令牌和限流；不要把 8787 端口直接暴露给公网。

`openctp-ctp==6.7.7.1` 是用于开发/仿真的 BSD-3-Clause Python 封装，原生库与操作系统、CPU 架构相关。若 SimNow 前置要求的 CTP 版本、看穿式采集或客户端认证与它不匹配，应改用 SimNow/期货公司提供的官方 SDK，并保持 `/board` 返回格式不变。此方案只读行情，不包含自动下单，也不会绕过期货公司、交易所或看穿式终端的合规要求。没有 SimNow 账号和前置参数时，线上页面会保持“CTP Bridge 尚未配置”，不会显示伪造实盘价格。

### 国金期货方案（仿真先行，实盘需经纪商授权）

国金期货公开的[外部接入/下载页](https://gjqh.com.cn/ws-2003417-c0003-cn/list_5692.shtml)列出了 CTP API、仿真参数和看穿式监管资料。仓库提供 `backend/guojin.env.example`，在同一个只读 Bridge 中通过 `CTP_PROFILE` 切换国金配置，不需要另写一套行情协议：

| 配置档 | 行情前置（CTP 格式） | BrokerID | 用途 |
| --- | --- | --- | --- |
| `guojin_sim_telecom` | `tcp://182.140.218.46:41407` | `1010` | 成都电信仿真 |
| `guojin_sim_unicom` | `tcp://119.6.88.69:41407` | `1010` | 成都联通仿真 |
| `guojin_production` | 必须由国金期货下发 | 必须以账户资料为准 | 本人生产行情 |

前两行是将国金页面公开的 IP/行情端口按 CTP `tcp://host:port` 格式整理后的值；交易端口 `41415` 仅用于交易程序，本项目不连接交易端口、不下单。实盘档不会猜测前置地址，避免把仿真地址误当生产地址。

国金页面同时提供看穿式评测版本 `v6.7.10_CP_20250415`、生产版本 `v6.7.13_20260225` 及客户自开发测试/上线指引。先下载与操作系统、CPU 架构匹配的官方 SDK，按国金要求完成看穿式终端采集、测试和上线认证；`openctp-ctp==6.7.7.1` 仅作为本地开发/仿真封装，不能替代国金要求的生产 SDK。若官方 SDK 不提供 Python 接口，用 C++/Java sidecar 读取 CTP 回调，再按现有 `/board` JSON 合同输出。

本次已核验的下载包用途如下：

| 文件 | 用途与核验结果 |
| --- | --- |
| `v6.7.13_20260225_trader.zip` | 国金生产版交易/行情 API 总包，内含 Trader API、MdUser API 的 Windows x86/x64 与 Linux x86_64 库及头文件；生产 Bridge 应以经纪商要求的版本和部署方式为准。 |
| `6.7.13_apidemo.zip` | 看穿式生产 Demo 的 C++ 工程、配置样例、Windows 预编译库和日志目录，用于理解回调与认证流程；样例配置中的账号字段仅作示例，不能直接用于实盘。 |
| `20200922_documents.zip` | CTP Client Development Guide 等开发文档，说明前置注册、登录、订阅和回调生命周期。 |
| `6.7.13chm_20260626.zip` | 6.7.13 API CHM 接口/字段/错误码参考，开发时查签名和返回码。 |
| `CTPMini_V1.7.5_20260115.zip` | CTP Mini V1.7.5 的 Linux64/Windows SDK 与开发手册；只有国金确认账户和前置支持 Mini 时才切换。 |

当前操作设备是 macOS arm64，而本次生产库是 Windows x86/x64 或 Linux x86_64，不能在本机直接加载。Mac 上安装的 `openctp-ctp` 只用于 Bridge 的结构/仿真自检，不等同于国金生产 SDK；生产行情需将只读 Bridge 部署到受信的 x86_64 Windows/Linux 主机，再把其 HTTPS `/board` 地址配置到 EdgeOne。生产前置、BrokerID、账户、AppID/AuthCode 和看穿式采集参数尚未由国金提供时，不执行真实登录，也不显示伪造行情。生产环境可复制 `backend/guojin-production.env.example`，填入经纪商下发值后再按下方流程验证。

本机验证方式：复制 `backend/guojin.env.example`，填写国金账号密码和当日有效合约；仿真选择一个 `guojin_sim_*` 档并按 SimNow 命令启动，`/health` 应显示 `provider: guojin_ctp`、`logged_in: true`、`quote_count > 0`。生产不要把 `guojin_production` 交给 `openctp-ctp` 启动：当前适配器会安全停在 `production_sdk_required`，必须在受信 x86_64 Windows/Linux 主机用国金 v6.7.13 官方 SDK/C++ 或 Java sidecar 输出同一 `/board` 合同，再配置 EdgeOne 的 HTTPS 地址和 `CTP_BRIDGE_TOKEN`。账号密码、AppID/AuthCode 和看穿式采集信息只放本机/受信主机的密钥环境，不上传 Git、不填网页。

### 同花顺 iFinD × 东方财富 Choice 多源校准

生产环境建议使用长期 `THS_IFIND_REFRESH_TOKEN`，由服务端按官方 `get_access_token` 流程自动换取并缓存 access_token；也可直接设置短期 `THS_IFIND_ACCESS_TOKEN`。适配器会解析 iFinD 官方 `tables` 返回结构，保留合约、指标和时间戳，并在返回错误时只显示脱敏后的状态。

页面的“同花顺 × Choice”区块通过 `/api/v1/sources/china` 汇总国内五个重点合约（沪金、沪银、沪铜、沪锡、上海原油）的授权行情和资讯，并与上期所官方延时基准核对。适配器只接受官方 API 或用户明确配置的 HTTPS JSON/RSS Feed；不抓取网页 HTML、Cookie、登录态，也不逆向终端协议。

EdgeOne 环境变量（全部只放服务端）：

```env
THS_IFIND_ACCESS_TOKEN=
THS_IFIND_REFRESH_TOKEN=
THS_IFIND_API_URL=
THS_IFIND_TOKEN_URL=https://quantapi.51ifind.com/api/v1/get_access_token
THS_IFIND_INDICATORS=latest,changeRatio,open,high,low,volume
THS_CONTRACT_CODES={"au":"AU.SHF","ag":"AG.SHF","cu":"CU.SHF","sn":"SN.SHF","sc":"SC.INE"}
THS_NEWS_FEED_URL=
EASTMONEY_CHOICE_TOKEN=
EASTMONEY_CHOICE_API_URL=
EASTMONEY_CONTRACT_CODES={"au":"AU0.SHF","ag":"AG0.SHF","cu":"CU0.SHF","sn":"SN0.SHF","sc":"SC0.INE"}
EASTMONEY_NEWS_FEED_URL=
# 历史/研究 sidecar（只在本人私有会话测试，不向公开版分发授权行）
EASTMONEY_CHOICE_HISTORY_TOKEN=
EASTMONEY_CHOICE_HISTORY_API_URL=
EASTMONEY_CHOICE_HISTORY_INDICATORS=open,high,low,close,volume
EASTMONEY_CHOICE_HISTORY_TIMEOUT_MS=5000
# 未取得实时/分钟授权前保持 false
EASTMONEY_CHOICE_REALTIME_ENABLED=false
CHINA_SOURCE_TIMEOUT_MS=8000
```

`THS_IFIND_ACCESS_TOKEN` 使用同花顺 iFinD 官方账号生成的访问令牌；官方接口的实时行情地址、请求头和字段说明见 [iFinD API 手册](https://quantapi.51ifind.com/gwstatic/static/ds_web/quantapi-web/help-center/manual.html)，免费账户额度见 [iFinD 权限说明](https://quantapi.51ifind.com/gwstatic/static/ds_web/quantapi-web/help-center/permission.html)。东方财富的 Choice API 地址和权限由 Choice 产品提供，因此代码不会猜测或硬编码一个未公开的 REST 地址；将 Choice 控制台/合同中给出的 HTTPS API 地址填入 `EASTMONEY_CHOICE_API_URL`，令牌填入 `EASTMONEY_CHOICE_TOKEN`。可参考 [Choice 数据服务](https://choice.eastmoney.com/product/datacenter) 与 [Choice 量化接口入口](https://quantapi.eastmoney.com/)。

Choice 连续合约代码使用东财格式：沪金、沪银、沪铜、沪锡和上海原油分别为 `AU0.SHF`、`AG0.SHF`、`CU0.SHF`、`SN0.SHF`、`SC0.INE`；iFinD 仍使用上方独立的 `THS_CONTRACT_CODES` 映射。具体月份合约按 `AUYYMM.SHF`、`AGYYMM.SHF` 等格式填写，并以 Choice 代码校验结果为准。

本次本机 SDK 联调已确认：`c.start("ForceLogin=1,USEHTTP=1,HTTPTimeout=30")` 返回 `0 success`，`cec("AU0.SHF,AG0.SHF")` 也返回代码有效；但 `csqsnapshot("AU0.SHF", ...)` 返回 `10001012 insufficient user access`。因此当前阻塞点是 Choice 账号未开通期货实时快照（CSQ/CSQS）权限，而不是 Mac、HTTP、动态库或连续合约代码问题。站点适配器现在会识别 SDK/sidecar 返回的 `ErrorCode`/`ErrorMsg` 及 `10001012`，在“同花顺 × Choice”卡片中显示权限类型、错误码和下一步，不会把空结果误报成实时行情。

Choice 适配器现在明确拆成两条通道。历史通道先使用官方 `c.csd` 序列函数，`Period=1/2/3/4` 分别对应日、周、月、年，已经可以作为回测和 K 线校准输入；估值、财务、行业和融资融券虽可在 Choice 账号中授权，但还需要在 sidecar 中按你的产品权限逐项映射官方函数与字段，页面会标为“待函数映射”，不会把它们误报成已返回。实时/分钟通道使用 CSQ/CSQS，未获交易所或行情产品授权时默认完全不调用。官方函数、参数和 SDK 下载入口见 [Choice 产品手册](https://quantapi.eastmoney.com/Manual?from=web)、[Choice Python SDK 手册](https://quantapi.eastmoney.com/Upload/EMQuantAPI_Python.pdf?_=639058106254967798) 和 [Choice 下载中心](https://quantapi.eastmoney.com/Download?from=web)。

历史通道通过本人可控的 HTTPS sidecar 接入，平台不会猜测 Choice 未公开的 HTTP 地址，也不会把授权历史行输出给公开访客。sidecar 收到如下请求后，用官方 SDK 调 `c.csd(codes, indicators, startdate, enddate, "Period=1,Order=1,AdjustFlag=1,Market=CNFESF,Ispandas=0")`，再返回归一化 JSON：

```json
{
  "function": "csd",
  "codes": ["AU0.SHF", "AG0.SHF"],
  "indicators": "open,high,low,close,volume",
  "startdate": "2026-01-01",
  "enddate": "2026-09-15",
  "options": "Period=1,Order=1,AdjustFlag=1,Market=CNFESF,Ispandas=0"
}
```

返回可使用 `{ "items": [{"code":"AU0.SHF","date":"2026-09-15","open":0,"high":0,"low":0,"close":0,"volume":0}] }`，也可直接返回 SDK 的 `Codes/Indicators/Dates/Data` 结构。将 sidecar 的 HTTPS 地址写入 `EASTMONEY_CHOICE_HISTORY_API_URL`，令牌写入 `EASTMONEY_CHOICE_HISTORY_TOKEN`，随后在本人私有版点击“测试 AU0.SHF 日线”。站点只保存归一化行和来源标签，令牌不进入浏览器、Git 或聊天消息；测试接口受私有会话保护，公开访客无法读取授权历史数据。

当前已知联调结果：`c.start("ForceLogin=1,USEHTTP=1,HTTPTimeout=30")` 和 `cec("AU0.SHF,AG0.SHF")` 成功，但 `csqsnapshot("AU0.SHF", ...)` 返回 `10001012 insufficient user access`。这说明 Choice 登录、HTTP 和连续合约代码均正常，缺的是实时快照权限；因此 `EASTMONEY_CHOICE_REALTIME_ENABLED` 保持 `false`。只有取得实时/分钟授权、完成实测并确认允许的展示范围后，才可改为 `true`，并重新部署服务端。

适配器会保留每个来源的合约、价格、时间戳和数据标签，并按来源中位价计算校准值：至少两个来源且价差不超过 0.5% 才显示“可用于研究校准”；否则显示“单源待核对/差异需复核”，不合成交易价。资讯按标题和原文链接去重，策略卡只输出“条件偏多/条件偏空/等待确认”、触发条件、失效条件和仓位边界；“证据置信度”不是胜率，也不构成投资建议。

请先核对并遵守 [Choice 用户协议](https://choice.eastmoney.com/html/userprotocol/userprotocol.html) 及 iFinD/数据供应商的授权和再分发条款；协议未允许的网页爬取、批量转载、反向工程或自动下单不会由本项目启用。

### 逐项接入状态

页面新增“数据接入中心 · 按顺序启用”区块，并提供只读接口 `/api/v1/sources/status`。它按 SimNow 仿真、交易所公开延时、iFinD/Choice 授权 API、CTP 生产 Bridge 四步返回 `ready`、`configured`、`partial`、`needs_setup` 或 `needs_authorization` 状态、官方入口和下一步操作。接口只返回布尔配置结果，不返回任何密钥、账号、密码或完整前置地址。

当前默认可用的是上期所公开延时 JSON（无 Key、约 60 秒轮询）以及已存在的免费国际/资讯适配器；SimNow 与 CTP 生产必须先在本机或受信主机启动 Bridge，iFinD/Choice 必须取得官方令牌和允许使用的 HTTPS API 地址。配置任一项后刷新页面即可看到状态由“待配置”变为“已接入/已接入一部分”，真实报价仍由原适配器按时间戳、币种和许可状态单独标注。

### 私人版完整接入流程

私人版默认关闭，只有完成下面的配置后才会向当前浏览器会话返回本人行情。整个流程不需要把期货账户密码放进网页或 EdgeOne。

1. **配置访问码。** 在 EdgeOne Pages 项目 `qijian-futures-intelligence` 的“项目设置 → 环境变量”中新增 `PRIVATE_ACCESS_CODE`，范围选择“生产”，填入强随机值并保存。保存后在“构建部署”中重新部署 `main`；不要把访问码提交到 Git 仓库或前端代码。
2. **准备本人 CTP Bridge。** 在中国大陆自有主机或受信网络运行 Bridge，使用期货公司提供的 CTP SDK/柜台连接行情。Bridge 只开放 HTTPS `GET /board`（或由项目配置的路径），并返回下方约定的归一化 JSON；设置 `CTP_BRIDGE_URL`，如 Bridge 要求鉴权再设置 `CTP_BRIDGE_TOKEN`。Bridge 应启用 TLS、访问令牌、来源限制和限流。
3. **验证网页登录。** 打开 `https://emcdb.com`，进入“本人 CTP 私有版”，点击“重新检查”；输入访问码并登录。登录成功后页面会显示会话到期时间（北京时间）以及“刷新 CTP 行情”按钮。访问码只用于换取 HttpOnly、Secure 会话 Cookie，浏览器不会展示或保存 CTP 密码。
4. **验证行情链路。** 点击“刷新 CTP 行情”。成功时会显示合约、最新价、买一/卖一、涨跌、成交量、持仓量、行情时间和延迟；所有时间统一显示为北京时间。若 Bridge 未启动或未配置，页面显示明确错误，不会回退为演示实盘价。
5. **日常与失效处理。** 会话默认 8 小时；点击“退出私有版”立即失效。到期、返回 401 或更换访问码后，重新输入新访问码即可。轮换访问码时：修改 EdgeOne 环境变量 → 保存 → 重新部署 → 退出旧会话 → 用新访问码登录。

Bridge 最小返回示例（字段可按实际行情补充）：

```json
{
  "items": [{
    "symbol": "au",
    "name": "沪金",
    "contract": "AU主连",
    "last": 558.12,
    "bid": 558.10,
    "ask": 558.14,
    "change_pct": 0.86,
    "volume": 274200,
    "open_interest": 158400,
    "as_of": "2026-09-05T10:28:00+08:00"
  }],
  "as_of": "2026-09-05T10:28:00+08:00",
  "latency_ms": 180
}
```

`as_of` 可使用带时区的 ISO 8601 时间；页面会统一格式化为北京时间。私人版只读行情，不提供自动下单；如需交易执行，必须另行完成期货公司授权、风控和合规评估。

## 金银比与图片辅助分析

前端会用黄金/白银报价计算金银比，并结合美元、实际利率、库存和 CFTC 净持仓给出相对强弱解读；金银比只作为组合风格过滤器，不单独触发交易。图片和资料分析支持一次添加最多 6 项 PNG/JPG/WebP/GIF、PDF、CSV、TXT、Markdown、JSON、Office 文件或 HTTP/HTTPS 网址，浏览器会先做本地预览、尺寸与大小校验，逐项显示读取/待提交/分析中/完成/失败状态和总体进度，用户点击“确认并分析”后才调用 /api/v1/image-analysis。生产视觉分析通过服务端 OPENAI_API_KEY（或兼容别名 VISION_API_KEY）调用 OpenAI Responses API，输出可见事实、技术观察、条件情景、风险与反证、缺失数据和证据置信度；密钥未配置或服务失败时明确报错，不生成演示结论，也不保存上传内容。

## 上线到自有域名

1. 将域名 A/AAAA 记录指向服务器；将 `deploy/nginx.conf` 的 `server_name` 改成真实域名。
2. 用 Certbot 或云负载均衡申请并自动续期 TLS 证书；推荐先仅开放 80/443。
3. 设置强随机数据库密码、限定 CORS 域名、以 secrets 注入 API 密钥，不提交 `.env`。
4. 启动后检查 `/health`，并为 API 错误率、数据延迟、Provider 失败、刷新耗时和磁盘备份配置告警。

### EdgeOne Pages 静态部署

仓库内的 `edgeone/` 是专为 EdgeOne Pages 准备的纯 React/Vite 静态入口。这样可以避免平台把包含 Vinext/Next 开发文件的根目录误判为 OpenNext 全栈项目。

在 EdgeOne 项目设置中将“根目录”设为 `/edgeone`，框架预设选“React”，编译命令为 `npm run build`，输出目录为 `build`，安装命令为 `npm install`，Node.js 选 `22.17.1`。保存后在“构建部署”中重新部署 `main` 分支。生产域名 `emcdb.com` 保持现有自定义域名和 CNAME，不需要重新配置 DNS。

EdgeOne Pages 负责静态前端；仓库同时提供 edgeone/cloud-functions/ 同域 API（/api/v1/market/board、/api/v1/market/{symbol}、/api/v1/market/candles?symbol=...、/api/v1/image-analysis），部署成功后无需跨域配置，前端默认直接调用当前域名。要启用免费源，在 EdgeOne 项目环境变量增加 ALPHAVANTAGE_API_KEY（只放服务端）；要接入 COMEX 黄金主连 GC1!，增加持牌/授权 JSON 地址 `COMEX_GOLD_FUTURES_URL`，可选 `COMEX_GOLD_FUTURES_TOKEN`，响应至少提供 `last`/`price`/`close` 之一及时间戳（接口支持 `change_pct`、`delayed` 字段）。要启用真实图片分析，另增 OPENAI_API_KEY（生产环境、仅服务端）和可选 OPENAI_VISION_MODEL。缺少任一密钥时，接口会返回“未配置/服务失败”状态，不会伪装成实盘或演示视觉结论。若使用更完整的 FastAPI 服务，则可继续把 backend/ 作为独立 API 运行，并在前端环境变量加入 NEXT_PUBLIC_API_URL=https://你的-api-域名 后重新部署。现货/外汇源没有可比昨收时，涨跌幅显示为“—”，避免把演示涨跌幅混入实时价格。

## 100 点平台对标优化

质量门现按 10 家平台 × 10 项能力展示 100 个可审计检查点：TradingView（图表与技术分析）、Bloomberg Terminal（宏观与研究工作流）、LSEG Workspace（跨资产与事件研究）、FactSet Workstation（组合与风险分析）、Barchart Trader（期货合约与数据纪律）、CQG Desktop（执行与交易纪律）、Sierra Chart（订单流与市场微观结构）、Bookmap（流动性与冲击识别）、Koyfin（看板与信息架构）、Trading Technologies（安全、合规与可观测性）。

页面会按“已落地 / 接入后完善 / 需授权”筛选，并显示每个平台的 10 个点及能力依据。这样可以把已完成的界面和规则、需要接入新 Provider 的路线、以及必须取得交易权限的功能分开审计；100 点不是收益率、胜率或交易所实时授权的保证。

每次发布前应运行 `npm run build`，并在 EdgeOne 以 `/edgeone`、`npm run build`、`build`、Node.js `22.17.1` 的配置部署；当前线上版本的回滚标签为 `backup/pre-100-point-optimization-2026-09-05`。

> Demo 数值与事件仅用于产品演示，不构成投资建议。
