from datetime import datetime
from types import SimpleNamespace

from fastapi.testclient import TestClient

from ctp_bridge import CTPConfig, SimNowBridge, create_app, normalize_depth_market_data


def _depth(**overrides):
    values = {
        "InstrumentID": "au2610",
        "TradingDay": "20260906",
        "ActionDay": "20260906",
        "UpdateTime": "10:28:00",
        "UpdateMillisec": 123,
        "LastPrice": 558.12,
        "PreSettlementPrice": 553.36,
        "PreClosePrice": 553.20,
        "OpenPrice": 555.00,
        "HighestPrice": 559.10,
        "LowestPrice": 554.80,
        "BidPrice1": 558.10,
        "BidVolume1": 2,
        "AskPrice1": 558.14,
        "AskVolume1": 3,
        "Volume": 274200,
        "OpenInterest": 158400,
        "AveragePrice": 557.50,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def test_normalize_depth_market_data_uses_beijing_time_and_ctp_fields():
    row = normalize_depth_market_data(_depth())
    assert row is not None
    assert row["symbol"] == "au"
    assert row["name"] == "沪金"
    assert row["contract"] == "au2610"
    assert row["currency"] == "CNY"
    assert row["data_mode"] == "ctp_realtime_private"
    assert row["bid"] == 558.1 and row["ask"] == 558.14
    assert row["change_pct"] == round((558.12 - 553.36) / 553.36 * 100, 6)
    parsed = datetime.fromisoformat(row["as_of"])
    assert parsed.utcoffset().total_seconds() == 8 * 3600
    assert parsed.strftime("%Y%m%d %H:%M:%S") == "20260906 10:28:00"


def test_normalize_depth_market_data_drops_empty_quote():
    assert normalize_depth_market_data(_depth(LastPrice=0, BidPrice1=0, AskPrice1=0)) is None
    assert normalize_depth_market_data(_depth(InstrumentID="")) is None


def test_bridge_disabled_health_is_safe_and_sanitized():
    bridge = SimNowBridge(CTPConfig(mode="disabled"))
    client = TestClient(create_app(bridge))
    response = client.get("/health")
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "disabled"
    assert payload["ready"] is False
    assert payload["configuration"]["credentials_loaded"] is False
    assert "password" not in str(payload).lower()


def test_bridge_requires_token_before_board_data():
    config = CTPConfig(
        mode="simnow",
        front="tcp://127.0.0.1:1",
        broker_id="9999",
        user_id="demo",
        password="secret",
        instruments=("au2610",),
        bridge_token="",
    )
    bridge = SimNowBridge(config)
    client = TestClient(create_app(bridge))
    response = client.get("/board")
    assert response.status_code == 503
    assert response.json()["status"] == "bridge_token_not_configured"
    assert "secret" not in response.text


def test_bridge_returns_only_fresh_logged_in_rows_with_bearer_token():
    config = CTPConfig(
        mode="simnow",
        front="tcp://127.0.0.1:1",
        broker_id="9999",
        user_id="demo",
        password="secret",
        instruments=("au2610",),
        bridge_token="bridge-secret",
    )
    bridge = SimNowBridge(config)
    bridge._connected = True
    bridge._logged_in = True
    bridge.on_depth_market_data(_depth())
    client = TestClient(create_app(bridge))
    response = client.get("/board", headers={"Authorization": "Bearer bridge-secret"})
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert payload["items"][0]["contract"] == "au2610"
    assert payload["items"][0]["currency"] == "CNY"
    assert "secret" not in response.text

