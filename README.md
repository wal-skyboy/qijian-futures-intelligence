# 期鉴 · 期货情报与策略平台

中文专业交易终端风格的可部署 MVP。前端为 React/TypeScript，API 为 FastAPI；默认 Demo Provider 无需密钥即可展示黄金、白银、锡的资讯研判、变化追踪与七日策略。

顶部品种搜索支持黄金、白银、锡、铜、原油、大豆、玉米和螺纹钢；切换品种后，行情、事件、利多/利空、日历、风险、策略和图片分析上下文会同步切换。未接入专属资讯流的品种会显示明确的通用模板与 Provider 待接入状态。

## 本地运行

前端：`npm install && npm run dev`。API：进入 `backend`，安装 requirements 后运行 `uvicorn app.main:app --reload`。生产整套服务可复制 `.env.example` 为 `.env` 后运行 `docker compose up -d --build`。

## 免费数据组合（当前默认）

默认 `MARKET_PROVIDER=free`：GDELT 新闻（`/api/v1/news/{symbol}`）、FRED 宏观（`/api/v1/macro`）、CFTC COT（`/api/v1/cot/{contract}`）和 Alpha Vantage 黄金/白银现货（`/api/v1/market/{symbol}`）。没有 Alpha Vantage/FRED Key 时会返回带 `data_mode` 的明确回退状态，绝不把 Demo 数值伪装成实时交易所价格。

配置 `.env`：

```env
MARKET_PROVIDER=free
NEWS_PROVIDER=gdelt
ALPHAVANTAGE_API_KEY=
FRED_API_KEY=
CFTC_APP_TOKEN=
VISION_PROVIDER=demo
VISION_API_KEY=
```

GDELT 不需 Key；CFTC 公共 PRE 低频访问通常不需 Token；FRED 需要免费账户 Key；Alpha Vantage 免费 Key 适合低频现货/历史查询。免费组合适合个人研究、延迟行情和资讯筛选，不提供 CME/COMEX/LME 的无限制实时 Tick、盘口或商业新闻再分发授权。生产公开服务前仍需核对各来源条款，并在需要时替换为持牌行情 Provider。

## 金银比与图片辅助分析

前端会用黄金/白银报价计算金银比，并结合美元、实际利率、库存和 CFTC 净持仓给出相对强弱解读；金银比只作为组合风格过滤器，不单独触发交易。图片分析支持 PNG/JPG/WebP，浏览器先做 8MB 校验和本地预览，再调用 `/api/v1/image-analysis`。默认 `VISION_PROVIDER=demo` 返回结构化的演示分析；接入生产视觉模型时，只需替换该 Provider，上传组件和返回字段保持不变。

## 上线到自有域名

1. 将域名 A/AAAA 记录指向服务器；将 `deploy/nginx.conf` 的 `server_name` 改成真实域名。
2. 用 Certbot 或云负载均衡申请并自动续期 TLS 证书；推荐先仅开放 80/443。
3. 设置强随机数据库密码、限定 CORS 域名、以 secrets 注入 API 密钥，不提交 `.env`。
4. 启动后检查 `/health`，并为 API 错误率、数据延迟、Provider 失败、刷新耗时和磁盘备份配置告警。

## 已实现的质量优化

本轮质量门展示 40 项检查：Provider 可替换、去重状态反馈、来源分级、事件影响评分、时效时间戳、置信度校准、观点版本化、增删/多空/策略 diff、宏观与技术面融合、成交量/OI、波动率与金银比、事件窗口、七日策略、仓位上限、止损、催化剂、风险清单、数据新鲜度、刷新去抖、缓存扩展点、移动端折叠、深色对比度、键盘焦点、错误恢复、API 健康检查、安全响应头、SEO、可观测性、提醒开关、时区明确、紧凑模式、来源健康、过期防护等。

能力基准参考了 TradingView 的多品种/观察列表提醒和经济日历、CME 的成交量与持仓工具、Bloomberg 的新闻与组合风险工作流；界面中的“质量门”会逐项展示这些检查项。

> Demo 数值与事件仅用于产品演示，不构成投资建议。
