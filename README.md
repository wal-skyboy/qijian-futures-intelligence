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

Provider 可替换、去重状态反馈、来源标识、事件影响评分、时效时间戳、置信度、跨来源验证标签、宏观/技术面标签、风险预算与止损、自动刷新去重、响应式导航、深浅色、键盘友好表单、服务健康检查、错误边界扩展点、日志/监控环境变量、限流与安全响应头、SEO 元数据。

> Demo 数值与事件仅用于产品演示，不构成投资建议。
