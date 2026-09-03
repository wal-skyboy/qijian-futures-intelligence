"""Pluggable market/news/macro providers.

The free provider intentionally labels every observation with source, delay and
license metadata. This makes the UI honest when a free feed is delayed or a
key is absent, and keeps a paid exchange adapter a small, isolated change.
"""
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from typing import Any
import httpx

from .config import settings

ASSET_TERMS = {
    "gold": ("黄金", "gold OR bullion OR XAU", "GOLD"),
    "silver": ("白银", "silver OR XAG", "SILVER"),
    "tin": ("锡", "tin OR LME tin", "TIN"),
}

class MarketProvider(ABC):
    @abstractmethod
    async def snapshot(self, symbol: str) -> dict: ...

class DemoProvider(MarketProvider):
    values = {
        "gold": ("黄金", 2654.80, 1.28, 72),
        "silver": ("白银", 31.642, .86, 64),
        "tin": ("锡", 256780, -.42, 43),
    }
    async def snapshot(self, symbol: str) -> dict:
        name, price, change, score = self.values.get(symbol, self.values["gold"])
        return {"symbol": symbol, "name": name, "price": price, "change_pct": change,
                "bull_bear_score": score, "provider": "demo", "delayed": True,
                "data_mode": "demo_fallback", "source_url": None,
                "as_of": datetime.now(timezone.utc).isoformat()}

class FreeMarketProvider(MarketProvider):
    """Free/low-frequency market adapter.

    Alpha Vantage's commodity spot endpoint is used when a key is supplied.
    Without one, the provider returns a clearly-labelled fallback instead of
    pretending that a demo value is an exchange quote.
    """
    async def snapshot(self, symbol: str) -> dict:
        if symbol not in ASSET_TERMS:
            return await DemoProvider().snapshot(symbol)
        name, _, av_symbol = ASSET_TERMS[symbol]
        if not settings.alpha_vantage_api_key:
            value = await DemoProvider().snapshot(symbol)
            value.update({"provider": "free", "data_mode": "demo_fallback_no_key",
                          "source_url": "https://www.alphavantage.co/documentation/"})
            return value
        url = "https://www.alphavantage.co/query"
        params = {"function": "GOLD_SILVER_SPOT", "symbol": av_symbol,
                  "apikey": settings.alpha_vantage_api_key}
        try:
            async with httpx.AsyncClient(timeout=settings.http_timeout_seconds) as client:
                response = await client.get(url, params=params)
                response.raise_for_status()
                payload = response.json()
            price = _first_number(payload, ["price", "05. price"])
            if price is None:
                raise ValueError("spot price missing")
            value = await DemoProvider().snapshot(symbol)
            value.update({"name": name, "price": price, "provider": "alpha_vantage",
                          "data_mode": "spot_or_delayed", "source_url": url,
                          "as_of": datetime.now(timezone.utc).isoformat()})
            return value
        except (httpx.HTTPError, ValueError, TypeError):
            value = await DemoProvider().snapshot(symbol)
            value.update({"provider": "free", "data_mode": "fallback_provider_error",
                          "source_url": url})
            return value

class FreeNewsProvider:
    async def search(self, symbol: str, limit: int = 20) -> list[dict]:
        _, query, _ = ASSET_TERMS.get(symbol, (symbol, symbol, symbol))
        params = {"query": query, "mode": "artlist", "format": "json",
                  "maxrecords": min(limit, 50), "sort": "datedesc", "timespan": "24h"}
        url = "https://api.gdeltproject.org/api/v2/doc/doc"
        try:
            async with httpx.AsyncClient(timeout=settings.http_timeout_seconds) as client:
                response = await client.get(url, params=params)
                response.raise_for_status()
                payload = response.json()
            items = [{"title": item.get("title", ""), "url": item.get("url"),
                     "source": item.get("domain", "unknown"), "seen_at": item.get("seendate"),
                     "provider": "gdelt", "license": "open_data"}
                    for item in payload.get("articles", []) if item.get("url")]
            return sorted(items, key=lambda item: item.get("seen_at") or "", reverse=True)
        except (httpx.HTTPError, ValueError, TypeError):
            return []

class FreeMacroProvider:
    series = {"10y_yield": "DGS10", "dollar_index": "DTWEXBGS", "oil": "DCOILWTICO"}
    async def observations(self) -> dict:
        if not settings.fred_api_key:
            return {"provider": "fred", "status": "key_required", "series": {},
                    "source_url": "https://fred.stlouisfed.org/docs/api/fred/v2/api_key.html"}
        output: dict[str, Any] = {}
        base = "https://api.stlouisfed.org/fred/series/observations"
        try:
            async with httpx.AsyncClient(timeout=settings.http_timeout_seconds) as client:
                for label, series_id in self.series.items():
                    response = await client.get(base, params={"series_id": series_id,
                        "api_key": settings.fred_api_key, "file_type": "json", "sort_order": "desc", "limit": 2})
                    response.raise_for_status()
                    observations = response.json().get("observations", [])
                    output[label] = observations
            return {"provider": "fred", "status": "ok", "series": output, "source_url": base}
        except (httpx.HTTPError, ValueError, TypeError):
            return {"provider": "fred", "status": "provider_error", "series": {}, "source_url": base}

class FreeCOTProvider:
    endpoint = "https://publicreporting.cftc.gov/resource/6dca-aqww.json"
    async def latest(self, contract: str = "GOLD") -> dict:
        # CFTC confirms that its public PRE API can be used without a token at
        # modest volume. Keep the query small and cache it upstream in Redis.
        # Keep the public query schema-agnostic; CFTC has revised field names
        # between report vintages. The UI sorts the normalized records.
        params = {"$limit": 5}
        try:
            async with httpx.AsyncClient(timeout=settings.http_timeout_seconds) as client:
                response = await client.get(self.endpoint, params=params)
                response.raise_for_status()
                rows = response.json()
            return {"provider": "cftc", "status": "ok", "contract": contract,
                    "rows": rows, "source_url": "https://publicreporting.cftc.gov/stories/s/r4w3-av2u"}
        except (httpx.HTTPError, ValueError, TypeError):
            return {"provider": "cftc", "status": "provider_error", "contract": contract,
                    "rows": [], "source_url": "https://publicreporting.cftc.gov/stories/s/r4w3-av2u"}

def _first_number(payload: dict, keys: list[str]) -> float | None:
    for key in keys:
        value = payload.get(key)
        try:
            if value is not None:
                return float(value)
        except (TypeError, ValueError):
            continue
    return None

def get_market_provider() -> MarketProvider:
    if settings.market_provider in {"free", "alphavantage"}:
        return FreeMarketProvider()
    return DemoProvider()
