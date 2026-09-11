"""Private CTP market-data bridge for the SimNow development route.

This process is intentionally separate from the public web/API service.  CTP
uses a stateful TCP connection which cannot be kept by an EdgeOne Pages
function, so the bridge runs on the owner's workstation or a trusted host and
exposes only a small, token-protected HTTPS-compatible JSON endpoint.

The bridge never accepts credentials over HTTP and never includes credentials
in a response.  Put the SimNow/CTP values in the process environment (or a
local secrets manager) and keep this service private.  The public dashboard
only receives the normalised snapshots returned by ``GET /board``.

``openctp-ctp`` is loaded lazily.  That keeps the normal FastAPI service and
the test suite usable on machines that do not have a native CTP library.  For
production trading, use the exact SDK build and distribution terms supplied
by the user's futures company; this adapter is intended for SimNow testing and
read-only market data.
"""

from __future__ import annotations

import hmac
import logging
import math
import os
import re
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from zoneinfo import ZoneInfo

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse


LOGGER = logging.getLogger("qijian.ctp_bridge")
BEIJING = ZoneInfo("Asia/Shanghai")
UTC = timezone.utc

DEFAULT_INSTRUMENTS = ("au2610", "ag2610", "cu2610", "sn2610", "sc2610")
SYMBOL_NAMES = {
    "au": "沪金",
    "ag": "沪银",
    "cu": "沪铜",
    "sn": "沪锡",
    "sc": "原油",
    "ni": "沪镍",
    "al": "沪铝",
    "zn": "沪锌",
    "pb": "沪铅",
    "rb": "螺纹钢",
    "i": "铁矿石",
    "m": "豆粕",
    "y": "豆油",
    "p": "棕榈油",
}

# Publicly documented Guojin simulation endpoints from the broker's download
# page.  Production fronts are intentionally not guessed: the broker must
# issue the account-specific front and SDK/看穿式 configuration.
CTP_PROFILE_PRESETS: dict[str, dict[str, str]] = {
    "simnow": {
        "provider": "simnow_ctp",
        "label": "SimNow 仿真",
        "official_api_url": "https://www.simnow.com.cn/static/apiDownload.action",
    },
    "guojin_sim_telecom": {
        "provider": "guojin_ctp",
        "label": "国金期货仿真 · 成都电信",
        "front": "tcp://182.140.218.46:41407",
        "broker_id": "1010",
        "official_api_url": "https://gjqh.com.cn/ws-2003417-c0003-cn/list_5692.shtml",
        "sdk_version": "evaluation-v6.7.10",
    },
    "guojin_sim_unicom": {
        "provider": "guojin_ctp",
        "label": "国金期货仿真 · 成都联通",
        "front": "tcp://119.6.88.69:41407",
        "broker_id": "1010",
        "official_api_url": "https://gjqh.com.cn/ws-2003417-c0003-cn/list_5692.shtml",
        "sdk_version": "evaluation-v6.7.10",
    },
    "guojin_production": {
        "provider": "guojin_ctp",
        "label": "国金期货实盘 · 前置待经纪商下发",
        "official_api_url": "https://gjqh.com.cn/ws-2003417-c0003-cn/list_5692.shtml",
        "sdk_version": "production-v6.7.13",
    },
}
CTP_PROFILE_ALIASES = {
    "guojin": "guojin_production",
    "guojin_sim": "guojin_sim_telecom",
    "guojin_telecom": "guojin_sim_telecom",
    "guojin_unicom": "guojin_sim_unicom",
}


def _env(name: str, default: str = "") -> str:
    return str(os.getenv(name, default) or "").strip()


def _bool_env(name: str, default: bool = False) -> bool:
    value = _env(name)
    if not value:
        return default
    return value.lower() in {"1", "true", "yes", "y", "on"}


def _split_env(name: str, default: Iterable[str] = ()) -> tuple[str, ...]:
    raw = _env(name)
    values = tuple(item.strip() for item in raw.split(",") if item.strip()) if raw else tuple(default)
    return tuple(dict.fromkeys(values))


@dataclass(frozen=True)
class CTPConfig:
    """Configuration loaded only from environment variables."""

    mode: str = "disabled"
    profile: str = "simnow"
    provider: str = "simnow_ctp"
    profile_label: str = "SimNow 仿真"
    official_api_url: str = "https://www.simnow.com.cn/static/apiDownload.action"
    sdk_version: str = ""
    front: str = ""
    broker_id: str = ""
    user_id: str = ""
    password: str = ""
    instruments: tuple[str, ...] = DEFAULT_INSTRUMENTS
    flow_path: str = ".cache/ctp-flow"
    user_product_info: str = "qijian-simnow"
    interface_product_info: str = "qijian-simnow"
    mac_address: str = ""
    client_ip: str = ""
    client_port: int = 0
    login_remark: str = ""
    app_id: str = ""
    auth_code: str = ""
    bridge_token: str = ""
    allow_unauthenticated: bool = False
    stale_after_ms: int = 5000

    @classmethod
    def from_env(cls) -> "CTPConfig":
        profile_raw = _env("CTP_PROFILE", "simnow").lower().replace("-", "_")
        profile = CTP_PROFILE_ALIASES.get(profile_raw, profile_raw)
        preset = CTP_PROFILE_PRESETS.get(profile, CTP_PROFILE_PRESETS["simnow"])
        try:
            client_port = max(0, int(_env("CTP_CLIENT_PORT", "0") or 0))
        except ValueError:
            client_port = 0
        try:
            stale_after_ms = max(500, min(120_000, int(_env("CTP_STALE_AFTER_MS", "5000") or 5000)))
        except ValueError:
            stale_after_ms = 5000
        return cls(
            mode=_env("CTP_MODE", "disabled").lower(),
            profile=profile,
            provider=_env("CTP_PROVIDER", preset.get("provider", "ctp")),
            profile_label=_env("CTP_PROFILE_LABEL", preset.get("label", profile)),
            official_api_url=_env("CTP_OFFICIAL_API_URL", preset.get("official_api_url", "")),
            sdk_version=_env("CTP_SDK_VERSION", preset.get("sdk_version", "")),
            front=_env("CTP_MD_FRONT") or preset.get("front", ""),
            broker_id=_env("CTP_BROKER_ID") or preset.get("broker_id", ""),
            user_id=_env("CTP_USER_ID"),
            password=_env("CTP_PASSWORD"),
            instruments=_split_env("CTP_INSTRUMENTS", DEFAULT_INSTRUMENTS),
            flow_path=_env("CTP_FLOW_PATH", ".cache/ctp-flow"),
            user_product_info=_env("CTP_USER_PRODUCT_INFO", "qijian-simnow"),
            interface_product_info=_env("CTP_INTERFACE_PRODUCT_INFO", "qijian-simnow"),
            mac_address=_env("CTP_MAC_ADDRESS"),
            client_ip=_env("CTP_CLIENT_IP"),
            client_port=client_port,
            login_remark=_env("CTP_LOGIN_REMARK"),
            app_id=_env("CTP_APP_ID"),
            auth_code=_env("CTP_AUTH_CODE"),
            bridge_token=_env("CTP_BRIDGE_TOKEN"),
            allow_unauthenticated=_bool_env("CTP_BRIDGE_ALLOW_UNAUTHENTICATED", False),
            stale_after_ms=stale_after_ms,
        )

    @property
    def enabled(self) -> bool:
        return self.mode not in {"", "disabled", "off", "false", "0"}

    @property
    def configured(self) -> bool:
        return bool(self.enabled and self.front and self.broker_id and self.user_id and self.password and self.instruments)

    @property
    def token_configured(self) -> bool:
        return bool(self.bridge_token) or self.allow_unauthenticated

    def public_summary(self) -> dict[str, Any]:
        """Return configuration facts without exposing endpoints or secrets."""

        return {
            "mode": self.mode or "disabled",
            "profile": self.profile,
            "provider": self.provider,
            "profile_label": self.profile_label,
            "sdk_version": self.sdk_version or None,
            "official_api_url": self.official_api_url or None,
            "enabled": self.enabled,
            "configured": self.configured,
            "token_configured": self.token_configured,
            "instrument_count": len(self.instruments),
            "stale_after_ms": self.stale_after_ms,
            "front_configured": bool(self.front),
            "broker_id_configured": bool(self.broker_id),
            "credentials_loaded": bool(self.broker_id and self.user_id and self.password),
        }


def _safe_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace").strip()
    return str(value).strip()


def _number(value: Any, *, positive: bool = False) -> float | int | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(parsed):
        return None
    if positive and parsed <= 0:
        return None
    if parsed.is_integer():
        return int(parsed)
    return parsed


def _first_number(item: Any, names: Iterable[str], *, positive: bool = False) -> float | int | None:
    for name in names:
        if hasattr(item, name):
            value = _number(getattr(item, name), positive=positive)
            if value is not None:
                return value
    return None


def _contract_parts(contract: str) -> tuple[str, str, str]:
    clean = contract.strip()
    match = re.match(r"([A-Za-z]+)", clean)
    prefix = match.group(1).lower() if match else clean.lower()
    symbol = prefix if prefix in SYMBOL_NAMES else prefix or "ctp"
    name = SYMBOL_NAMES.get(prefix, clean or "CTP 合约")
    return symbol, name, clean


def _as_of(action_day: Any, trading_day: Any, update_time: Any, update_millisec: Any) -> str:
    """Build a Beijing ISO timestamp from CTP's split date/time fields."""

    day = _safe_text(action_day) or _safe_text(trading_day)
    clock = _safe_text(update_time)
    if re.fullmatch(r"\d{8}", day) and re.fullmatch(r"\d{2}:\d{2}:\d{2}", clock):
        try:
            milliseconds = int(_number(update_millisec) or 0)
            milliseconds = max(0, min(999, milliseconds))
            parsed = datetime.strptime(f"{day} {clock}", "%Y%m%d %H:%M:%S").replace(tzinfo=BEIJING)
            return parsed.replace(microsecond=milliseconds * 1000).isoformat()
        except ValueError:
            pass
    return datetime.now(BEIJING).isoformat()


def normalize_depth_market_data(item: Any, *, provider: str = "simnow_ctp") -> dict[str, Any] | None:
    """Convert a CTP depth callback into the dashboard's private contract.

    The function accepts a duck-typed object so it can be tested without a
    native CTP library and can be reused by another official SDK wrapper.
    Values reported as zero/negative by CTP for an unavailable level become
    ``None`` rather than a fake quote.
    """

    contract = _safe_text(getattr(item, "InstrumentID", ""))
    if not contract:
        return None
    symbol, name, clean_contract = _contract_parts(contract)
    last = _first_number(item, ("LastPrice",), positive=True)
    bid = _first_number(item, ("BidPrice1",), positive=True)
    ask = _first_number(item, ("AskPrice1",), positive=True)
    if last is None and bid is None and ask is None:
        return None
    previous = _first_number(item, ("PreSettlementPrice", "PreClosePrice"), positive=True)
    change_pct = None
    if isinstance(last, (int, float)) and isinstance(previous, (int, float)) and previous > 0:
        change_pct = round((float(last) - float(previous)) / float(previous) * 100, 6)
    as_of = _as_of(
        getattr(item, "ActionDay", ""),
        getattr(item, "TradingDay", ""),
        getattr(item, "UpdateTime", ""),
        getattr(item, "UpdateMillisec", 0),
    )
    return {
        "symbol": symbol,
        "name": name,
        "contract": clean_contract,
        "last": last,
        "bid": bid,
        "ask": ask,
        "change_pct": change_pct,
        "volume": _first_number(item, ("Volume",)),
        "open_interest": _first_number(item, ("OpenInterest",)),
        "pre_settlement": previous,
        "pre_close": _first_number(item, ("PreClosePrice",), positive=True),
        "open": _first_number(item, ("OpenPrice",), positive=True),
        "high": _first_number(item, ("HighestPrice",), positive=True),
        "low": _first_number(item, ("LowestPrice",), positive=True),
        "average_price": _first_number(item, ("AveragePrice",), positive=True),
        "bid_volume": _first_number(item, ("BidVolume1",)),
        "ask_volume": _first_number(item, ("AskVolume1",)),
        "currency": "CNY",
        "data_mode": "ctp_realtime_private",
        "provider": provider,
        "delayed": False,
        "as_of": as_of,
    }


def _make_spi(mdapi: Any, bridge: "SimNowBridge") -> Any:
    """Build a SWIG callback object while keeping the native import optional."""

    base = mdapi.CThostFtdcMdSpi

    class MarketDataSpi(base):
        def OnFrontConnected(self) -> None:  # noqa: N802 - CTP callback name
            bridge.on_front_connected()

        def OnFrontDisconnected(self, reason: int) -> None:  # noqa: N802
            bridge.on_front_disconnected(reason)

        def OnRspUserLogin(self, rsp_login: Any, rsp_info: Any, request_id: int, is_last: bool) -> None:  # noqa: N802
            bridge.on_rsp_user_login(rsp_login, rsp_info, request_id, is_last)

        def OnRspError(self, rsp_info: Any, request_id: int, is_last: bool) -> None:  # noqa: N802
            bridge.on_rsp_error(rsp_info, request_id, is_last)

        def OnRspSubMarketData(self, instrument: Any, rsp_info: Any, request_id: int, is_last: bool) -> None:  # noqa: N802
            bridge.on_rsp_sub_market_data(instrument, rsp_info, request_id, is_last)

        def OnRtnDepthMarketData(self, depth: Any) -> None:  # noqa: N802
            bridge.on_depth_market_data(depth)

        # Some official API builds expose authentication callbacks.  The
        # openctp-ctp build used for SimNow may not, so the bridge checks for
        # the request method before attempting the optional handshake.
        def OnRspAuthenticate(self, rsp_auth: Any, rsp_info: Any, request_id: int, is_last: bool) -> None:  # noqa: N802
            bridge.on_rsp_authenticate(rsp_auth, rsp_info, request_id, is_last)

    return MarketDataSpi()


class SimNowBridge:
    """Thread-safe quote cache backed by SimNow or a broker CTP front."""

    def __init__(self, config: CTPConfig | None = None) -> None:
        self.config = config or CTPConfig.from_env()
        self._lock = threading.RLock()
        self._api: Any | None = None
        self._spi: Any | None = None
        self._request_seq = 0
        self._quotes: dict[str, dict[str, Any]] = {}
        self._received_at: dict[str, float] = {}
        self._last_quote_at: datetime | None = None
        self._last_error: str = ""
        self._last_error_id: int | None = None
        self._state = "disabled" if not self.config.enabled else "not_configured"
        self._connected = False
        self._logged_in = False
        self._started = False
        self._trading_day = ""
        self._login_time = ""
        self._warning = ""

    @property
    def api(self) -> Any | None:
        return self._api

    def _next_request_id(self) -> int:
        with self._lock:
            self._request_seq += 1
            return self._request_seq

    def _set_error(self, message: Any, error_id: Any = None) -> None:
        text = _safe_text(message)
        # CTP messages are normally broker-generated.  Redact the few values
        # that could identify an account or expose a configured endpoint.
        for secret in (self.config.user_id, self.config.broker_id, self.config.password, self.config.front):
            if secret:
                text = text.replace(secret, "[redacted]")
        try:
            parsed_id = int(error_id) if error_id is not None else None
        except (TypeError, ValueError):
            parsed_id = None
        with self._lock:
            self._last_error = text[:240]
            self._last_error_id = parsed_id

    @staticmethod
    def _rsp_error(rsp_info: Any) -> tuple[int, str]:
        if rsp_info is None:
            return 0, ""
        raw_id = getattr(rsp_info, "ErrorID", 0)
        raw_message = getattr(rsp_info, "ErrorMsg", "")
        try:
            error_id = int(raw_id or 0)
        except (TypeError, ValueError):
            error_id = 0
        return error_id, _safe_text(raw_message)

    def start(self) -> None:
        """Start the native API without blocking the HTTP server thread."""

        if not self.config.enabled:
            with self._lock:
                self._state = "disabled"
            return
        if not self.config.configured:
            with self._lock:
                self._state = "not_configured"
                self._last_error = "缺少 CTP_MODE、CTP_MD_FRONT、CTP_BROKER_ID、CTP_USER_ID、CTP_PASSWORD 或 CTP_INSTRUMENTS。"
            return
        # The bundled openctp-ctp wheel is a development/simulation wrapper
        # and must never be mistaken for the broker's production SDK. The
        # official Guojin v6.7.13 libraries are architecture-specific and
        # normally require the broker's C++/Java sidecar plus compliance
        # collection. Keep this adapter read-only and fail closed until that
        # sidecar exposes the same /board contract.
        if self.config.profile == "guojin_production":
            with self._lock:
                self._state = "production_sdk_required"
                self._last_error = "生产档不会加载 openctp-ctp；请在受信 x86_64 Windows/Linux 主机用国金 v6.7.13 官方 SDK sidecar 提供 /board。"
            return
        with self._lock:
            if self._started:
                return
            self._state = "loading_sdk"
        try:
            from openctp_ctp import mdapi  # type: ignore[import-not-found]
        except Exception as exc:  # pragma: no cover - depends on native wheel
            with self._lock:
                self._state = "dependency_missing"
            self._set_error(f"无法加载 openctp-ctp：{type(exc).__name__}")
            LOGGER.error("CTP SDK import failed: %s", type(exc).__name__)
            return
        try:
            flow = Path(self.config.flow_path).expanduser()
            flow.mkdir(parents=True, exist_ok=True)
            spi = _make_spi(mdapi, self)
            api = mdapi.CThostFtdcMdApi.CreateFtdcMdApi(str(flow), False)
            api.RegisterSpi(spi)
            api.RegisterFront(self.config.front)
            with self._lock:
                self._api = api
                self._spi = spi
                self._started = True
                self._state = "connecting"
            api.Init()
            LOGGER.info("CTP bridge started in %s mode for %d instrument(s)", self.config.mode, len(self.config.instruments))
        except Exception as exc:  # pragma: no cover - depends on native wheel
            with self._lock:
                self._state = "start_error"
            self._set_error(f"CTP API 启动失败：{type(exc).__name__}")
            LOGGER.exception("CTP bridge start failed")

    def stop(self) -> None:
        with self._lock:
            api, self._api, self._spi = self._api, None, None
            self._started = False
            self._connected = False
            self._logged_in = False
            if self.config.enabled:
                self._state = "stopped"
        if api is not None:
            try:
                api.Release()
            except Exception:
                LOGGER.debug("CTP API release failed", exc_info=True)

    def on_front_connected(self) -> None:
        with self._lock:
            self._connected = True
            self._logged_in = False
            self._state = "front_connected"
            self._last_error = ""
        self._request_login_or_authenticate()

    def on_front_disconnected(self, reason: Any) -> None:
        with self._lock:
            self._connected = False
            self._logged_in = False
            self._state = "disconnected"
        self._set_error(f"CTP 前置连接断开（原因代码 {_safe_text(reason) or '未知'}）")

    def _request_login_or_authenticate(self) -> None:
        api = self.api
        if api is None:
            return
        # Official API builds that expose ReqAuthenticate need an auth
        # callback.  If the installed wrapper does not expose it, fall back to
        # the normal login request; SimNow accounts that require authentication
        # should then use the broker's matching official SDK build.
        if self.config.app_id and self.config.auth_code and callable(getattr(api, "ReqAuthenticate", None)):
            try:
                from openctp_ctp import mdapi  # type: ignore[import-not-found]

                request = mdapi.CThostFtdcReqAuthenticateField()
                request.BrokerID = self.config.broker_id
                request.UserID = self.config.user_id
                request.UserProductInfo = self.config.user_product_info
                request.AuthCode = self.config.auth_code
                request.AppID = self.config.app_id
                result = api.ReqAuthenticate(request, self._next_request_id())
                with self._lock:
                    self._state = "authenticating" if result == 0 else "auth_error"
                if result != 0:
                    self._set_error("CTP 客户端认证请求未接受", result)
                return
            except Exception as exc:  # pragma: no cover - depends on SDK build
                self._set_error(f"CTP 客户端认证失败：{type(exc).__name__}")
                with self._lock:
                    self._state = "auth_error"
                return
        if self.config.app_id and self.config.auth_code:
            with self._lock:
                self._warning = "当前 CTP Python 封装未暴露 ReqAuthenticate，已直接尝试登录；若前置要求客户端认证，请改用期货公司匹配的官方 SDK。"
        self._request_login()

    def on_rsp_authenticate(self, _rsp_auth: Any, rsp_info: Any, _request_id: int, _is_last: bool) -> None:
        error_id, message = self._rsp_error(rsp_info)
        if error_id:
            self._set_error(message or "CTP 客户端认证失败", error_id)
            with self._lock:
                self._state = "auth_error"
            return
        self._request_login()

    def _request_login(self) -> None:
        api = self.api
        if api is None:
            return
        try:
            from openctp_ctp import mdapi  # type: ignore[import-not-found]

            request = mdapi.CThostFtdcReqUserLoginField()
            request.BrokerID = self.config.broker_id
            request.UserID = self.config.user_id
            request.Password = self.config.password
            request.UserProductInfo = self.config.user_product_info
            request.InterfaceProductInfo = self.config.interface_product_info
            if self.config.mac_address:
                request.MacAddress = self.config.mac_address
            if self.config.login_remark:
                request.LoginRemark = self.config.login_remark
            if self.config.client_ip:
                request.ClientIPAddress = self.config.client_ip
            if self.config.client_port:
                request.ClientIPPort = self.config.client_port
            result = api.ReqUserLogin(request, self._next_request_id())
            with self._lock:
                self._state = "logging_in" if result == 0 else "login_error"
            if result != 0:
                self._set_error("CTP 登录请求未接受", result)
        except Exception as exc:  # pragma: no cover - depends on native wheel
            self._set_error(f"CTP 登录请求失败：{type(exc).__name__}")
            with self._lock:
                self._state = "login_error"

    def on_rsp_user_login(self, rsp_login: Any, rsp_info: Any, _request_id: int, _is_last: bool) -> None:
        error_id, message = self._rsp_error(rsp_info)
        if error_id:
            self._set_error(message or "CTP 登录失败", error_id)
            with self._lock:
                self._logged_in = False
                self._state = "login_failed"
            return
        with self._lock:
            self._logged_in = True
            self._state = "logged_in"
            self._trading_day = _safe_text(getattr(rsp_login, "TradingDay", ""))
            self._login_time = _safe_text(getattr(rsp_login, "LoginTime", ""))
        self._subscribe()

    def _subscribe(self) -> None:
        api = self.api
        if api is None:
            return
        # The SWIG typemap expects a list of bytes, not Python strings.
        identifiers = [instrument.encode("ascii", errors="ignore") for instrument in self.config.instruments]
        try:
            result = api.SubscribeMarketData(identifiers, len(identifiers))
            with self._lock:
                self._state = "subscribed_waiting_tick" if result == 0 else "subscription_error"
            if result != 0:
                self._set_error("CTP 行情订阅请求未接受", result)
        except Exception as exc:  # pragma: no cover - depends on native wheel
            self._set_error(f"CTP 行情订阅失败：{type(exc).__name__}")
            with self._lock:
                self._state = "subscription_error"

    def on_rsp_sub_market_data(self, instrument: Any, rsp_info: Any, _request_id: int, _is_last: bool) -> None:
        error_id, message = self._rsp_error(rsp_info)
        if error_id:
            identifier = _safe_text(getattr(instrument, "InstrumentID", ""))
            self._set_error(f"合约 {identifier or '未知'} 订阅失败：{message or '未知错误'}", error_id)

    def on_rsp_error(self, rsp_info: Any, _request_id: int, _is_last: bool) -> None:
        error_id, message = self._rsp_error(rsp_info)
        if error_id:
            self._set_error(message or "CTP 返回错误", error_id)

    def on_depth_market_data(self, depth: Any) -> None:
        row = normalize_depth_market_data(depth, provider=self.config.provider)
        if row is None:
            return
        contract = row["contract"]
        now = time.monotonic()
        with self._lock:
            self._quotes[contract] = row
            self._received_at[contract] = now
            self._last_quote_at = datetime.now(UTC)
            self._state = "live"
            self._last_error = ""

    def _fresh_rows(self, now: float | None = None) -> list[dict[str, Any]]:
        current = time.monotonic() if now is None else now
        max_age = self.config.stale_after_ms / 1000
        order = {instrument.lower(): index for index, instrument in enumerate(self.config.instruments)}
        rows: list[tuple[int, dict[str, Any]]] = []
        for contract, row in self._quotes.items():
            received = self._received_at.get(contract, 0)
            if current - received <= max_age:
                rows.append((order.get(contract.lower(), len(order)), row))
        rows.sort(key=lambda pair: (pair[0], pair[1].get("contract", "")))
        return [dict(row) for _, row in rows]

    def health_payload(self) -> dict[str, Any]:
        now = time.monotonic()
        with self._lock:
            fresh_count = len(self._fresh_rows(now))
            age_ms = None
            if self._last_quote_at:
                age_ms = max(0, round((datetime.now(UTC) - self._last_quote_at).total_seconds() * 1000))
            ready = bool(self._connected and self._logged_in and fresh_count)
            return {
                "status": "ok" if ready else self._state,
                "ready": ready,
                "provider": self.config.provider,
                "profile": self.config.profile,
                "profile_label": self.config.profile_label,
                "data_mode": "ctp_realtime_private",
                "connected": self._connected,
                "logged_in": self._logged_in,
                "quote_count": fresh_count,
                "quote_age_ms": age_ms,
                "last_quote_at": self._last_quote_at.isoformat() if self._last_quote_at else None,
                "trading_day": self._trading_day or None,
                "login_time": self._login_time or None,
                "error_id": self._last_error_id,
                "error": self._last_error or None,
                "warning": self._warning or None,
                "configuration": self.config.public_summary(),
            }

    def board_payload(self) -> dict[str, Any]:
        with self._lock:
            rows = self._fresh_rows()
            ready = bool(self._connected and self._logged_in)
            if not ready:
                rows = []
            now = datetime.now(UTC)
            status = "ok" if rows else ("stale" if ready and self._quotes else self._state)
            note = f"{self.config.profile_label} CTP 实时行情，仅限本人 Bridge 会话；报价时间统一为北京时间。"
            if status == "stale":
                note = "CTP 前置已登录，但超过 freshness 窗口未收到新 Tick；已停止输出旧报价。"
            elif status in {"not_configured", "disabled"}:
                note = f"尚未配置 {self.config.profile_label} CTP Bridge 环境变量；不会生成演示行情。"
            elif status in {"dependency_missing", "start_error", "production_sdk_required"}:
                note = self._last_error or "CTP SDK 尚未成功加载。"
            return {
                "status": status,
                "audience": "private_owner",
                "scope": "仅限本人登录",
                "provider": self.config.provider,
                "profile": self.config.profile,
                "profile_label": self.config.profile_label,
                "data_mode": "ctp_realtime_private",
                "delayed": False,
                "as_of": max((row.get("as_of", "") for row in rows), default=now.isoformat()),
                "latency_ms": self.health_payload().get("quote_age_ms"),
                "items": rows,
                "note": note,
            }

    def authorized(self, request: Request) -> bool:
        if self.config.allow_unauthenticated and not self.config.bridge_token:
            return True
        authorization = request.headers.get("authorization", "")
        supplied = authorization[7:].strip() if authorization.lower().startswith("bearer ") else ""
        return bool(self.config.bridge_token and supplied and hmac.compare_digest(supplied, self.config.bridge_token))


def create_app(bridge: SimNowBridge | None = None) -> FastAPI:
    current_bridge = bridge or SimNowBridge()
    app = FastAPI(title="期鉴 SimNow CTP Bridge", version="1.0.0", docs_url=None, redoc_url=None)

    @app.on_event("startup")
    async def _start_bridge() -> None:
        current_bridge.start()

    @app.on_event("shutdown")
    async def _stop_bridge() -> None:
        current_bridge.stop()

    @app.get("/")
    async def root() -> dict[str, Any]:
        return {
            "service": "qijian-ctp-bridge",
            "endpoints": ["/health", "/board"],
            "mode": "read_only_market_data",
            "provider": current_bridge.config.provider,
            "profile": current_bridge.config.profile,
        }

    @app.get("/health")
    async def health() -> dict[str, Any]:
        # Keep the process health endpoint HTTP 200 so a supervisor can show a
        # useful not_configured/not_ready state instead of restarting forever.
        return current_bridge.health_payload()

    @app.get("/board")
    async def board(request: Request) -> JSONResponse:
        if not current_bridge.config.token_configured:
            return JSONResponse(
                {
                    "status": "bridge_token_not_configured",
                    "audience": "private_owner",
                    "items": [],
                    "note": "请设置 CTP_BRIDGE_TOKEN；仅本机临时调试才可显式启用 CTP_BRIDGE_ALLOW_UNAUTHENTICATED。",
                },
                status_code=503,
                headers={"Cache-Control": "no-store"},
            )
        if not current_bridge.authorized(request):
            return JSONResponse(
                {"status": "unauthorized", "audience": "private_owner", "items": [], "note": "Bridge 令牌无效。"},
                status_code=401,
                headers={"Cache-Control": "no-store", "WWW-Authenticate": "Bearer"},
            )
        payload = current_bridge.board_payload()
        status_code = 200 if payload["status"] == "ok" else 503
        return JSONResponse(payload, status_code=status_code, headers={"Cache-Control": "no-store"})

    return app


app = create_app()


if __name__ == "__main__":  # pragma: no cover - convenience entry point
    import uvicorn

    uvicorn.run(app, host=_env("BRIDGE_HOST", "127.0.0.1"), port=int(_env("BRIDGE_PORT", "8787") or 8787))
