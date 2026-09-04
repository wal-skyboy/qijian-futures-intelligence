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
    # name, GDELT query, Alpha Vantage symbol, endpoint function, freshness mode
    "gold": ("黄金", "gold OR bullion OR XAU", "GOLD", "GOLD_SILVER_SPOT", "spot_realtime"),
    "silver": ("白银", "silver OR XAG", "SILVER", "GOLD_SILVER_SPOT", "spot_realtime"),
    "copper": ("铜", "copper OR copper futures", "COPPER", "COPPER", "daily_reference"),
    "tin": ("锡", "tin OR LME tin", "TIN", "", "licensed_delayed_required"),
    "crude": ("原油", "crude oil OR WTI OR Brent", "WTI", "WTI", "daily_reference"),
    "usd": ("美元", "US dollar OR DXY OR Federal Reserve", "USD/CNY", "CURRENCY_EXCHANGE_RATE", "fx_realtime"),
}

SOURCE_URLS = {
    "gold": "https://www.alphavantage.co/documentation/",
    "silver": "https://www.alphavantage.co/documentation/",
    "copper": "https://www.alphavantage.co/documentation/",
    "crude": "https://www.alphavantage.co/documentation/",
    "usd": "https://www.alphavantage.co/documentation/",
    "tin": "https://www.lme.com/Metals/Non-ferrous/LME-Tin",
}

class MarketProvider(ABC):
    @abstractmethod
    async def snapshot(self, symbol: str) -> dict: ...

class DemoProvider(MarketProvider):
    values = {
        "gold": ("黄金", 2654.80, 1.28, 72),
        "silver": ("白银", 31.642, .86, 64),
        "tin": ("锡", 256780, -.42, 43),
        "copper": ("铜", 9842.50, .34, 58),
        "crude": ("原油", 78.420, -.67, 47),
        "usd": ("美元", 103.42, -.18, 52),
        "soybean": ("大豆", 1018.25, .22, 54),
        "corn": ("玉米", 412.75, -.18, 49),
        "rebar": ("螺纹钢", 3462, -.31, 45),
    }
    async def snapshot(self, symbol: str) -> dict:
        name, price, change, score = self.values.get(symbol, self.values["gold"])
        return {"symbol": symbol, "name": name, "price": price, "change_pct": change,
                "bull_bear_score": score, "provider": "demo", "delayed": True,
                "data_mode": "demo_fallback", "source_url": None,
                "as_of": datetime.now(timezone.utc).isoformat()}

class FreeMarketProvider(MarketProvider):
    """Free Alpha Vantage adapter with explicit freshness/licence labels.

    The free key unlocks live *spot* gold/silver and live FX (USD/CNY). The
    public COPPER and WTI endpoints are daily reference series, while LME tin
    still needs an authorised exchange feed. No branch is allowed to call a
    demo value an exchange-level futures quote.
    """
    async def snapshot(self, symbol: str) -> dict:
        if symbol not in ASSET_TERMS:
            return await DemoProvider().snapshot(symbol)
        name, _, av_symbol, function, freshness = ASSET_TERMS[symbol]
        source_url = SOURCE_URLS.get(symbol, "https://www.alphavantage.co/documentation/")
        if not settings.alpha_vantage_api_key:
            value = await DemoProvider().snapshot(symbol)
            value.update({"provider": "free", "data_mode": "demo_fallback_no_key",
                          "source_url": source_url, "freshness": "待配置免费 Key"})
            return value
        if not function:
            value = await DemoProvider().snapshot(symbol)
            value.update({"provider": "free", "data_mode": freshness,
                          "source_url": source_url, "freshness": "交易所授权数据"})
            return value
        url = "https://www.alphavantage.co/query"
        params = {"function": function, "apikey": settings.alpha_vantage_api_key}
        if function == "GOLD_SILVER_SPOT":
            params["symbol"] = av_symbol
        elif function == "CURRENCY_EXCHANGE_RATE":
            params.update({"from_currency": "USD", "to_currency": "CNY"})
        else:
            params.update({"interval": "daily", "datatype": "json"})
        try:
            async with httpx.AsyncClient(timeout=settings.http_timeout_seconds) as client:
                response = await client.get(url, params=params)
                response.raise_for_status()
                payload = response.json()
            price, as_of, change_pct = _parse_alpha_vantage_quote(payload, function)
            if price is None:
                raise ValueError("spot price missing")
            value = await DemoProvider().snapshot(symbol)
            value.update({"name": name, "price": price, "provider": "alpha_vantage",
                          "data_mode": freshness, "source_url": source_url,
                          "freshness": freshness, "as_of": as_of or datetime.now(timezone.utc).isoformat(),
                          "delayed": freshness not in {"spot_realtime", "fx_realtime"}})
            # Spot and FX endpoints do not always include a comparable prior
            # close. Preserve null instead of leaking the demo percentage into
            # a live price card; daily commodity series provide a real delta.
            value["change_pct"] = change_pct
            return value
        except (httpx.HTTPError, ValueError, TypeError):
            value = await DemoProvider().snapshot(symbol)
            value.update({"provider": "free", "data_mode": "fallback_provider_error",
                          "source_url": source_url, "freshness": "Provider 异常，已回退演示值"})
            return value

class FreeNewsProvider:
    async def search(self, symbol: str, limit: int = 20) -> list[dict]:
        _, query, *_ = ASSET_TERMS.get(symbol, (symbol, symbol, symbol, "", ""))
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

def _parse_alpha_vantage_quote(payload: dict, function: str) -> tuple[float | None, str | None, float | None]:
    """Normalize Alpha Vantage spot, FX and daily commodity responses."""
    if function == "GOLD_SILVER_SPOT":
        price = _first_number(payload, ["price", "05. price"])
        return price, _first_text(payload, ["last_refreshed", "7. Last Refreshed"]), None
    if function == "CURRENCY_EXCHANGE_RATE":
        price = _first_number(payload, ["5. Exchange Rate", "exchange_rate", "rate"])
        return price, _first_text(payload, ["6. Last Refreshed", "timestamp"]), None
    rows = payload.get("data") or payload.get("values") or payload.get("series") or []
    if isinstance(rows, list):
        parsed: list[tuple[float, str | None]] = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            value = _first_number(row, ["value", "close", "price", "4. close"])
            if value is not None:
                parsed.append((value, _first_text(row, ["date", "timestamp", "time"])))
        if parsed:
            latest = parsed[0]
            previous = parsed[1] if len(parsed) > 1 else None
            change = ((latest[0] - previous[0]) / previous[0] * 100) if previous and previous[0] else None
            return latest[0], latest[1], change
    return _first_number(payload, ["price", "value", "05. price"]), None, None


def _first_text(payload: dict, keys: list[str]) -> str | None:
    for key in keys:
        value = payload.get(key)
        if value is not None and str(value).strip():
            return str(value)
    return None


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
