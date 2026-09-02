from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from .config import settings
from .providers import get_provider

app = FastAPI(title="期鉴 API", version="1.0.0", docs_url="/api/docs")
app.add_middleware(CORSMiddleware, allow_origins=settings.allowed_origins.split(","), allow_methods=["GET"], allow_headers=["*"])

@app.get("/health")
async def health(): return {"status": "ok", "provider": settings.provider, "mode": settings.app_env}

@app.get("/api/v1/market/{symbol}")
async def market(symbol: str): return await get_provider().snapshot(symbol)

@app.get("/api/v1/search")
async def search(q: str = Query(min_length=1, max_length=40)):
    all_assets = [{"symbol":"gold","name":"黄金"},{"symbol":"silver","name":"白银"},{"symbol":"tin","name":"锡"},
                  {"symbol":"copper","name":"铜"},{"symbol":"crude","name":"原油"},{"symbol":"soybean","name":"大豆"}]
    query = q.lower()
    return [x for x in all_assets if query in x["symbol"] or q in x["name"]][:8]

@app.get("/api/v1/changes/{symbol}")
async def changes(symbol: str):
    return {"symbol": symbol, "items": [
        {"type":"added","field":"event","label":"新增宏观事件","at":"2026-09-03T02:26:00Z"},
        {"type":"sentiment_changed","from":"neutral","to":"bullish","label":"观点由中性转为利多","at":"2026-09-03T02:10:00Z"},
        {"type":"strategy_adjusted","field":"stop_loss","from":2626,"to":2632,"label":"止损位上移","at":"2026-09-03T01:52:00Z"}]}
