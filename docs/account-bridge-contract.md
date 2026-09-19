# 本机实盘只读 Bridge 接口约定

此约定用于把用户在本机运行的东方财富/CTP 适配器的**脱敏快照**提供给期鉴网页做风险研究。网页端只发起 `GET` 请求，不保存或转发账号凭据，也不提供下单入口。

## 传输要求

- 仅允许 `http://` 或 `https://` URL；生产 HTTPS 页面访问本机时优先使用 HTTPS 或受信反向代理。
- 返回 `Content-Type: application/json`，并允许当前页面的 CORS 来源（不得使用含凭据的通配配置）。
- 建议本机绑定 `127.0.0.1`，只读进程设置防火墙规则；网页每 5 秒轮询一次，单次超时 2.5 秒。
- 不要在 JSON、URL、响应头或日志中放入密码、令牌、Cookie、会话、投资者编号、账号 ID 或任何下单字段。

## 最小返回示例

```json
{
  "status": "ok",
  "read_only": true,
  "order_enabled": false,
  "source": "local-redacted-ctp",
  "data_mode": "live_read_only",
  "as_of": "2026-09-16T01:00:00+08:00",
  "latency_ms": 35,
  "account": {
    "equity": 100000,
    "available": 80000,
    "margin_used": 20000,
    "unrealized_pnl": 120,
    "currency": "CNY"
  },
  "positions": [
    {
      "symbol": "au2610",
      "name": "沪金",
      "direction": "多",
      "quantity": 2,
      "avg_price": 700,
      "last_price": 710,
      "unrealized_pnl": 20,
      "margin": 1400,
      "currency": "CNY",
      "as_of": "2026-09-16T01:00:00+08:00"
    }
  ]
}
```

`account`、持仓价格、盈亏和保证金字段可以省略或填 `null`；但 `symbol`、`quantity` 与每条持仓的 `as_of` 必须有效。网页会对时间戳、数字、持仓数量和敏感字段再次校验，校验失败则不展示数据。

## 东方财富桌面字段映射

如果你的本机适配器读取的是东方财富电脑端的只读行情快照，可以把字段转换为下面的结构后返回；网页也兼容常见中文别名（例如 `最新价`、`涨跌幅`、`买一价`、`卖一价`、`成交量`、`持仓量`）。网页不会直接读取桌面窗口、密码、Cookie 或交易接口。

```json
{
  "status": "ok",
  "read_only": true,
  "order_enabled": false,
  "source": "eastmoney-local-redacted",
  "data_mode": "live_read_only",
  "as_of": "2026-09-18T23:41:20+08:00",
  "quote": {
    "symbol": "ag2610",
    "name": "沪银2610",
    "contract": "AG主连",
    "latest": 16156,
    "change": 100,
    "change_pct": 0.62,
    "average": 16180,
    "open": 16239,
    "high": 16271,
    "low": 16090,
    "prev_close": 16056,
    "bid1": 16155,
    "ask1": 16156,
    "bid1_qty": 13,
    "ask1_qty": 5,
    "volume": 109700,
    "open_interest": 144148,
    "currency": "CNY",
    "as_of": "2026-09-18T23:41:20+08:00"
  },
  "order_book": {"bids": [{"price": 16155, "quantity": 13}], "asks": [{"price": 16156, "quantity": 5}]},
  "trades": [{"time": "2026-09-18T23:41:18+08:00", "price": 16156, "quantity": 2, "direction": "多开", "position_change": 1}],
  "candle_series": [{"interval": "1m", "rows": [{"time": "2026-09-18T23:41:00+08:00", "open": 16155, "high": 16158, "low": 16154, "close": 16156, "volume": 18}]}],
  "positions": []
}
```

`quote`、`order_book`、`trades` 和 `candle_series` 都是可选的；提供后，页面会显示最新价、买卖一档、日内 OHLC、成交/持仓统计、数据时间及条件化研究提示。适配器必须自行取得合法的只读数据来源；不要通过逆向协议、模拟登录、读取浏览器 Cookie 或绕过东方财富/期货公司的权限限制来获取数据。

## 处理原则

网页只做数据新鲜度、保证金占用、品种集中度和缺价检查，输出风险提示与条件化研究建议。它不会把建议转换成交易指令，也不会代替期货公司风控。Bridge 未连接或数据超过 30 秒未更新时，系统会暂停方向性结论并标记为待验证。
