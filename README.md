# 期鉴 · 期货情报与策略平台

中文专业交易终端风格的可部署 MVP。前端为 React/TypeScript，API 为 FastAPI；默认 Demo Provider 无需密钥即可展示黄金、白银、锡的资讯研判、变化追踪与七日策略。

## 本地运行

前端：`npm install && npm run dev`。API：进入 `backend`，安装 requirements 后运行 `uvicorn app.main:app --reload`。生产整套服务可复制 `.env.example` 为 `.env` 后运行 `docker compose up -d --build`。

## 生产数据接入

实现 `backend/app/providers.py` 中的 `MarketProvider` 接口，然后用 `MARKET_PROVIDER` 选择。实时行情密钥填入 `MARKET_DATA_API_KEY`，资讯聚合密钥填入 `NEWS_API_KEY`。生产使用前应确认行情和新闻的再分发授权。

## 上线到自有域名

1. 将域名 A/AAAA 记录指向服务器；将 `deploy/nginx.conf` 的 `server_name` 改成真实域名。
2. 用 Certbot 或云负载均衡申请并自动续期 TLS 证书；推荐先仅开放 80/443。
3. 设置强随机数据库密码、限定 CORS 域名、以 secrets 注入 API 密钥，不提交 `.env`。
4. 启动后检查 `/health`，并为 API 错误率、数据延迟、Provider 失败、刷新耗时和磁盘备份配置告警。

## 已实现的质量优化

本轮质量门展示 40 项检查：Provider 可替换、去重状态反馈、来源分级、事件影响评分、时效时间戳、置信度校准、观点版本化、增删/多空/策略 diff、宏观与技术面融合、成交量/OI、波动率与金银比、事件窗口、七日策略、仓位上限、止损、催化剂、风险清单、数据新鲜度、刷新去抖、缓存扩展点、移动端折叠、深色对比度、键盘焦点、错误恢复、API 健康检查、安全响应头、SEO、可观测性、提醒开关、时区明确、紧凑模式、来源健康、过期防护等。

能力基准参考了 TradingView 的多品种/观察列表提醒和经济日历、CME 的成交量与持仓工具、Bloomberg 的新闻与组合风险工作流；界面中的“质量门”会逐项展示这些检查项。

> Demo 数值与事件仅用于产品演示，不构成投资建议。
