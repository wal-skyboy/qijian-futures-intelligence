import asyncio
from datetime import datetime, timezone
from time import monotonic
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
