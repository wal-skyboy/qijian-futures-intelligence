from abc import ABC, abstractmethod
from datetime import datetime, timezone

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
                "as_of": datetime.now(timezone.utc).isoformat()}

def get_provider() -> MarketProvider:
    # Production adapters implement MarketProvider and are selected by MARKET_PROVIDER.
    return DemoProvider()
