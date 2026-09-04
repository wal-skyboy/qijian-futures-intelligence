import asyncio
import hashlib
import math
import re
from datetime import datetime, timezone
from time import monotonic
from zoneinfo import ZoneInfo
from pydantic import BaseModel, Field
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from .config import settings
from .providers import FreeCOTProvider, FreeMacroProvider, FreeNewsProvider, get_market_provider

app = FastAPI(title="期鉴 API", version="1.0.0", docs_url="/api/docs")
app.add_middleware(CORSMiddleware, allow_origins=settings.allowed_origins.split(","), allow_methods=["GET", "POST"], allow_headers=["*"])

MARKET_SYMBOLS = ("gold", "silver", "copper", "tin", "crude", "usd")
_board_cache: dict[str, object] = {"expires_at": 0.0, "payload": None}
_board_lock = asyncio.Lock()
BOARD_CACHE_SECONDS = 15
_events_cache: dict[str, object] = {"expires_at": 0.0, "payload": None}
_events_lock = asyncio.Lock()
EVENTS_CACHE_SECONDS = 60

EVENT_ASSETS = (
    ("黄金", re.compile(r"gold|bullion|xau|黄金", re.I), ("贵金属", "宏观")),
    ("白银", re.compile(r"silver|xag|白银", re.I), ("贵金属", "工业需求")),
    ("铜", re.compile(r"copper|铜", re.I), ("有色", "中国需求")),
    ("锡", re.compile(r"tin|锡", re.I), ("有色", "供应")),
    ("原油", re.compile(r"crude|wti|brent|oil|原油|石油", re.I), ("能源", "供给")),
    ("美元", re.compile(r"dollar|dxy|usd|美元|汇率", re.I), ("外汇", "宏观")),
)
BULLISH_EVENT_TERMS = re.compile(r"safe haven|dovish|rate cut|yield (?:falls?|drops?)|weaker dollar|demand (?:rises?|improves?)|shortage|stimulus|避险|降息|收益率回落|美元走弱|需求改善|供应扰动|上涨|走强", re.I)
BEARISH_EVENT_TERMS = re.compile(r"hawkish|rate hike|yield (?:rises?|jumps?)|stronger dollar|inventory (?:build|rises?|increase)|oversupply|sell[- ]?off|demand (?:falls?|slows?)|recession|加息|收益率上行|美元走强|库存增加|累库|供应过剩|下跌|走弱", re.I)

def _event_date(value: object) -> datetime:
    raw = str(value or "").strip()
    match = re.fullmatch(r"(\d{8})T(\d{6})Z", raw)
    if match:
        date, time = match.groups()
        raw = f"{date[:4]}-{date[4:6]}-{date[6:]}T{time[:2]}:{time[2:4]}:{time[4:]}+00:00"
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return datetime.now(timezone.utc)

def _normalise_event(raw: dict, index: int, provider_url: str) -> dict | None:
    title = str(raw.get("title") or raw.get("headline") or raw.get("name") or "").strip()
    summary = str(raw.get("summary") or raw.get("description") or raw.get("snippet") or "").strip()
    if not title and not summary:
        return None
    source_url = str(raw.get("source_url") or raw.get("sourceUrl") or raw.get("url") or raw.get("link") or "").strip()
    if not source_url.startswith(("http://", "https://")):
        source_url = provider_url
    text = f"{title} {summary}"
    raw_asset = str(raw.get("asset") or "").strip()
    asset, tags = next(((name, list(default_tags)) for name, pattern, default_tags in EVENT_ASSETS if pattern.search(raw_asset)), (None, []))
    if not asset:
        asset, tags = next(((name, list(default_tags)) for name, pattern, default_tags in EVENT_ASSETS if pattern.search(text)), ("黄金", ["贵金属", "宏观"]))
    raw_side = str(raw.get("side") or raw.get("sentiment") or "").lower()
    if raw_side in {"利多", "bullish", "positive"}:
        side = "利多"
    elif raw_side in {"利空", "bearish", "negative"}:
        side = "利空"
    elif BULLISH_EVENT_TERMS.search(text) and not BEARISH_EVENT_TERMS.search(text):
        side = "利多"
    elif BEARISH_EVENT_TERMS.search(text) and not BULLISH_EVENT_TERMS.search(text):
        side = "利空"
    else:
        side = "中性"
    published = _event_date(raw.get("published_at") or raw.get("publishedAt") or raw.get("seendate") or raw.get("date"))
    impact = raw.get("impact") or raw.get("impact_score")
    confidence = raw.get("confidence")
    try:
        impact = max(35, min(98, int(float(impact))))
    except (TypeError, ValueError):
        impact = 52 if side == "中性" else 68
    try:
        confidence = max(35, min(96, int(float(confidence))))
    except (TypeError, ValueError):
        confidence = 56 if side == "中性" else 70
    source = str(raw.get("source") or raw.get("publisher") or raw.get("domain") or "GDELT").strip() or "GDELT"
    if re.search(r"central bank|fed|ecb|interest rate|yield|央行|利率|收益率", text, re.I): tags.append("宏观")
    if re.search(r"inventory|warehouse|stock|库存|仓单|持仓", text, re.I): tags.append("库存/持仓")
    tags = list(dict.fromkeys(tags))[:4] or ["全球事件", "待验证"]
    stable_id = int(hashlib.sha1(f"{source_url}|{title}".encode("utf-8")).hexdigest()[:8], 16)
    return {
        "id": stable_id or 9000 + index,
        "asset": asset, "side": side, "title": title or f"{asset}全球关键事件",
        "summary": summary or f"{asset}相关全球资讯已抓取；请结合价格、美元、实际利率、库存和持仓交叉验证。",
        "source": source, "sourceUrl": source_url, "publishedAt": published.isoformat(),
        "time": published.astimezone(ZoneInfo("Asia/Shanghai")).strftime("%H:%M"),
        "impact": impact, "confidence": confidence, "tags": tags,
    }

class ImageAnalysisRequest(BaseModel):
    file_name: str = Field(default="image", max_length=160)
    mime_type: str = Field(default="image/jpeg", max_length=80)
    size_bytes: int = Field(default=0, ge=0, le=8 * 1024 * 1024)
    width: int = Field(default=0, ge=0, le=20000)
    height: int = Field(default=0, ge=0, le=20000)
    asset: str = Field(default="gold", max_length=20)

async def _market_board_payload() -> dict:
    """Fetch one coherent quote snapshot for the board.

    The short server-side cache prevents a 10-second browser refresh from
    multiplying calls against free-provider rate limits while preserving a
    single sync timestamp for every row in the board.
    """
    now = monotonic()
    cached = _board_cache.get("payload")
    if cached is not None and now < float(_board_cache.get("expires_at", 0.0)):
        return cached  # type: ignore[return-value]
    async with _board_lock:
        now = monotonic()
        cached = _board_cache.get("payload")
        if cached is not None and now < float(_board_cache.get("expires_at", 0.0)):
            return cached  # type: ignore[return-value]
        started = monotonic()
        rows = await asyncio.gather(*(get_market_provider().snapshot(item) for item in MARKET_SYMBOLS))
        synced_at = datetime.now(timezone.utc).isoformat()
        live_modes = {"spot_realtime", "fx_realtime"}
        live_count = sum(1 for row in rows if row.get("data_mode") in live_modes)
        payload = {
            "items": rows,
            "as_of": synced_at,
            "sync": {
                "status": "ok",
                "synced_at": synced_at,
                "latency_ms": round((monotonic() - started) * 1000, 1),
                "refresh_mode": "polling",
                "cache_ttl_seconds": BOARD_CACHE_SECONDS,
                "live_count": live_count,
                "item_count": len(rows),
            },
            "coverage": [
                {"name": "黄金 / 白银现货", "mode": "spot_realtime", "source_url": "https://www.alphavantage.co/documentation/"},
                {"name": "美元 USD/CNY", "mode": "fx_realtime", "source_url": "https://www.alphavantage.co/documentation/"},
                {"name": "铜 / WTI 原油", "mode": "daily_reference", "source_url": "https://www.alphavantage.co/documentation/"},
                {"name": "LME 锡", "mode": "licensed_delayed_required", "source_url": "https://www.lme.com/Metals/Non-ferrous/LME-Tin"},
                {"name": "CFTC COT", "mode": "weekly", "source_url": "https://publicreporting.cftc.gov/stories/s/r4w3-av2u"},
                {"name": "FRED 宏观", "mode": "daily", "source_url": "https://fred.stlouisfed.org/docs/api/fred/"},
            ],
        }
        _board_cache.update({"expires_at": monotonic() + BOARD_CACHE_SECONDS, "payload": payload})
        return payload

@app.get("/health")
async def health():
    return {"status": "ok", "market_provider": settings.market_provider,
            "news_provider": settings.news_provider, "mode": settings.app_env,
            "free_sources": ["gdelt", "fred", "cftc", "alpha_vantage_spot", "alpha_vantage_fx", "alpha_vantage_daily"],
            "market_freshness": {"gold": "spot_realtime", "silver": "spot_realtime", "usd": "fx_realtime",
                                 "copper": "daily_reference", "crude": "daily_reference", "tin": "licensed_delayed_required"}}

@app.get("/api/v1/market/{symbol}")
async def market(symbol: str):
    # Keep this compatibility guard because FastAPI resolves the parameterized
    # route before the more specific /market/global declaration below.
    if symbol in {"global", "board"}:
        return await _market_board_payload()
    return await get_market_provider().snapshot(symbol)

@app.get("/api/v1/market/global")
async def global_market():
    """Return the currently available cross-market snapshots with honest mode labels."""
    return await _market_board_payload()

@app.get("/api/v1/market/{symbol}/candles")
async def market_candles(symbol: str, interval: str = Query(default="daily")):
    """Return a stable OHLC contract for the chart.

    The EdgeOne production adapter enriches this contract with Alpha Vantage
    history when available. The standalone FastAPI service keeps a labelled
    deterministic fallback so local/demo deployments never render a blank
    panel when no history provider is configured.
    """
    normalized = interval.lower() if interval.lower() in {"daily", "weekly", "monthly"} else "daily"
    snapshot = await get_market_provider().snapshot(symbol)
    base = float(snapshot.get("price") or 1)
    now = datetime.now(timezone.utc)
    step_days = {"daily": 1, "weekly": 7, "monthly": 30}[normalized]
    rows = []
    previous = base * 0.972
    for index in range(36):
        close = base * (0.972 + 0.004 * math.sin(index * 0.63) + (index / 35) * 0.012)
        open_price = previous
        spread = max(abs(close) * 0.004, 0.0001)
        rows.append({"time": (now.timestamp() - (35 - index) * step_days * 86400),
                     "open": open_price, "high": max(open_price, close) + spread,
                     "low": max(0, min(open_price, close) - spread), "close": close})
        previous = close
    for row in rows:
        row["time"] = datetime.fromtimestamp(row["time"], timezone.utc).isoformat()
    live_mode = snapshot.get("data_mode") in {"spot_realtime", "fx_realtime"}
    return {"symbol": symbol, "name": snapshot.get("name", symbol), "interval": normalized,
            "provider": snapshot.get("provider", "demo"), "data_mode": snapshot.get("data_mode", "demo_fallback"),
            "data_label": "实时报价 + 本地历史演示K线" if live_mode else "本地演示K线",
            "is_live": live_mode, "synthetic": True, "as_of": snapshot.get("as_of"),
            "source_url": snapshot.get("source_url"), "freshness": snapshot.get("freshness", "演示数据"),
            "note": "本地 FastAPI 未启用历史 OHLC Provider，当前 K 线为结构演示；不代表交易所实时 OHLC。",
            "candles": rows}

@app.get("/api/v1/strategy/{symbol}")
async def strategy(symbol: str):
    snapshot = await get_market_provider().snapshot(symbol)
    score = int(snapshot.get("bull_bear_score", 50))
    bias = "偏多" if score >= 65 else "偏空" if score <= 40 else "中性"
    return {"symbol": symbol, "bias": bias, "score": score,
            "data_mode": snapshot.get("data_mode"), "provider": snapshot.get("provider"),
            "price": snapshot.get("price"), "change_pct": snapshot.get("change_pct"),
            "trigger": "价格、宏观与持仓信号共振后执行；事件前降低仓位",
            "invalid": "价格跌破结构支撑或数据与价格出现明显背离",
            "as_of": snapshot.get("as_of")}

@app.post("/api/v1/image-analysis")
async def image_analysis(payload: ImageAnalysisRequest):
    """Stable adapter contract for chart/image analysis.

    The default deployment intentionally returns a labelled demo result. A
    production vision provider can replace this function without changing the
    upload UI or response shape.
    """
    asset_name = {"gold": "黄金", "silver": "白银", "copper": "铜", "tin": "锡", "crude": "原油", "usd": "美元"}.get(payload.asset, payload.asset)
    return {"provider": "demo_vision", "mode": "演示分析", "received": True,
            "analysis_status": "demo", "received_at": datetime.now(timezone.utc).isoformat(),
            "title": f"{asset_name} 图片结构已读取",
            "conclusion": f"已接收 {payload.file_name}（{payload.width}×{payload.height}），当前 {asset_name} 研判仍需结合价格、成交量、持仓和事件窗口交叉验证。",
            "signals": ["识别趋势线、支撑阻力与突破形态", "检查图表周期、合约月份和时间戳", "对照金银比 / 宏观数据确认是否背离"],
            "next": "配置生产视觉模型后，可进一步返回 OCR、K 线形态、关键价位和图中标注解释。"}

@app.get("/api/v1/news/{symbol}")
async def news(symbol: str, limit: int = Query(default=20, ge=1, le=50)):
    return {"symbol": symbol, "items": await FreeNewsProvider().search(symbol, limit)}

@app.get("/api/v1/events")
async def events(limit: int = Query(default=40, ge=1, le=50)):
    """Return one deduplicable global event window for scheduled polling."""
    now = monotonic()
    cached = _events_cache.get("payload")
    if cached is not None and now < float(_events_cache.get("expires_at", 0.0)):
        return cached
    async with _events_lock:
        now = monotonic()
        cached = _events_cache.get("payload")
        if cached is not None and now < float(_events_cache.get("expires_at", 0.0)):
            return cached
        started = monotonic()
        rows = await FreeNewsProvider().search_global(limit)
        provider_url = settings.global_events_url.strip() or "https://api.gdeltproject.org/api/v2/doc/doc"
        items = [item for index, row in enumerate(rows) if (item := _normalise_event(row, index, provider_url))]
        # Stable URL/title dedupe keeps a 10-second browser poll from creating
        # duplicate cards when a publisher appears in multiple GDELT records.
        seen: set[str] = set()
        unique = []
        for item in items:
            key = f"{item['sourceUrl']}|{item['title']}".lower()
            if key in seen:
                continue
            seen.add(key)
            unique.append(item)
        unique.sort(key=lambda item: item["publishedAt"], reverse=True)
        unique = unique[:limit]
        fetched_at = datetime.now(timezone.utc).isoformat()
        configured = settings.global_events_url.strip()
        payload = {
            "status": "ok" if unique else "empty", "provider": "configured_events" if configured else "gdelt",
            "fetched_at": fetched_at, "source_url": provider_url,
            "items": unique,
            "timeline": [{"id": item["id"], "date": item["publishedAt"][:10], "window": "未来7天" if _event_date(item["publishedAt"]) > datetime.now(timezone.utc) else "过去7天",
                          "side": item["side"], "impact": "高" if item["impact"] >= 80 else "中",
                          "title": item["title"], "assets": item["asset"], "why": item["summary"],
                          "source": item["source"], "sourceUrl": item["sourceUrl"]} for item in unique],
            "sync": {"status": "ok" if unique else "empty", "synced_at": fetched_at,
                     "latency_ms": round((monotonic() - started) * 1000, 1), "refresh_mode": "polling",
                     "cache_ttl_seconds": EVENTS_CACHE_SECONDS, "item_count": len(unique), "stale": False},
        }
        _events_cache.update({"expires_at": monotonic() + EVENTS_CACHE_SECONDS, "payload": payload})
        return payload

@app.get("/api/v1/macro")
async def macro(): return await FreeMacroProvider().observations()

@app.get("/api/v1/cot/{contract}")
async def cot(contract: str): return await FreeCOTProvider().latest(contract)

@app.get("/api/v1/search")
async def search(q: str = Query(min_length=1, max_length=40)):
    all_assets = [{"symbol":"gold","name":"黄金"},{"symbol":"silver","name":"白银"},
                  {"symbol":"copper","name":"铜"},{"symbol":"tin","name":"锡"},{"symbol":"crude","name":"原油"},
                  {"symbol":"usd","name":"美元"},{"symbol":"soybean","name":"大豆"},
                  {"symbol":"corn","name":"玉米"},{"symbol":"rebar","name":"螺纹钢"}]
    query = q.lower()
    return [x for x in all_assets if query in x["symbol"] or q in x["name"]][:8]

@app.get("/api/v1/changes/{symbol}")
async def changes(symbol: str):
    return {"symbol": symbol, "items": [
        {"type":"added","field":"event","label":"新增宏观事件","at":"2026-09-03T02:26:00Z"},
        {"type":"sentiment_changed","from":"neutral","to":"bullish","label":"观点由中性转为利多","at":"2026-09-03T02:10:00Z"},
        {"type":"strategy_adjusted","field":"stop_loss","from":2626,"to":2632,"label":"止损位上移","at":"2026-09-03T01:52:00Z"}]}
