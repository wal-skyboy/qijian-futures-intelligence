#!/usr/bin/env python3
"""Read-only HTTPS-sidecar adapter for the official Choice Python SDK.

The public site calls this process with a small JSON request.  The process must
run on the owner's Mac or another trusted host where the licensed Choice SDK is
installed and already authenticated.  It never returns the Choice token.

This module intentionally serves HTTP on localhost by default.  Put it behind
an HTTPS reverse proxy/tunnel that enforces the same ``CHOICE_SIDECAR_TOKEN``
before configuring the EdgeOne environment variables.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlparse


PERIODS = {"1": 1, "2": 2, "3": 3, "4": 4}
DEFAULT_INDICATORS = "open,high,low,close,volume"
MAX_CODES = 20
MAX_BODY_BYTES = 32 * 1024
SDK_LOCK = threading.Lock()


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def text(value: Any) -> str:
    return "" if value is None else str(value).strip()


def error_payload(code: str, message: str, status: int = 400) -> tuple[dict[str, Any], int]:
    return ({"status": "error", "error_code": code, "message": message, "as_of": utc_now()}, status)


def load_choice(sdk_root: str):
    root = os.path.abspath(sdk_root)
    if root not in sys.path:
        sys.path.insert(0, root)
    from EmQuantAPI import c  # type: ignore

    return c


def sdk_result(request: dict[str, Any], sdk_root: str) -> tuple[dict[str, Any], int]:
    raw_codes = request.get("codes") or request.get("code") or ["AU0.SHF"]
    if isinstance(raw_codes, str):
        codes = [item.strip() for item in raw_codes.replace("；", ",").split(",") if item.strip()]
    else:
        codes = [text(item) for item in raw_codes if text(item)]
    codes = codes[:MAX_CODES]
    indicators = text(request.get("indicators") or DEFAULT_INDICATORS)
    start = text(request.get("startdate") or request.get("start"))
    end = text(request.get("enddate") or request.get("end"))
    options = text(request.get("options"))
    if not codes or not start or not end:
        return error_payload("invalid_request", "codes、startdate 和 enddate 为必填项")
    if text(request.get("function") or "csd").lower() != "csd":
        return error_payload("unsupported_function", "sidecar 只开放只读 csd 历史序列")

    # The SDK has global import/session state and is not safe to initialize or
    # use concurrently. Serialize requests so retries cannot deadlock Python's
    # import lock or leave multiple heartbeat threads behind.
    with SDK_LOCK:
        c = load_choice(sdk_root)
        login = c.start("ForceLogin=1,USEHTTP=1,HTTPTimeout=30")
        if getattr(login, "ErrorCode", 1) != 0:
            return {
                "status": "provider_error",
                "error_code": str(getattr(login, "ErrorCode", "login")),
                "message": text(getattr(login, "ErrorMsg", "Choice SDK login failed")),
                "as_of": utc_now(),
            }, 502
        try:
            result = c.csd(
                ",".join(codes), indicators, start, end,
                options or "Period=1,Order=1,AdjustFlag=1,Market=CNFESF,Ispandas=0",
            )
            code = getattr(result, "ErrorCode", 1)
            if code != 0:
                return {
                    "status": "provider_error",
                    "error_code": str(code),
                    "message": text(getattr(result, "ErrorMsg", "Choice csd failed")),
                    "as_of": utc_now(),
                }, 502
            return {
                "status": "ok",
                "function": "csd",
                "Codes": getattr(result, "Codes", codes),
                "Indicators": getattr(result, "Indicators", indicators.split(",")),
                "Dates": getattr(result, "Dates", []),
                "Data": getattr(result, "Data", {}),
                "as_of": utc_now(),
            }, 200
        finally:
            c.stop()


class Handler(BaseHTTPRequestHandler):
    server_version = "ChoiceHistorySidecar/1.0"

    def _write(self, payload: dict[str, Any], status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        expected = text(os.environ.get("CHOICE_SIDECAR_TOKEN"))
        if not expected:
            return False
        actual = self.headers.get("Authorization", "")
        return actual == f"Bearer {expected}"

    def do_GET(self) -> None:  # noqa: N802
        if urlparse(self.path).path == "/health":
            self._write({"status": "ok", "provider": "choice_sdk", "read_only": True, "as_of": utc_now()})
            return
        self._write({"status": "not_found"}, 404)

    def do_POST(self) -> None:  # noqa: N802
        if urlparse(self.path).path not in ("/history", "/"):
            self._write({"status": "not_found"}, 404)
            return
        if not self._authorized():
            self._write({"status": "authentication_error", "message": "sidecar token required"}, 401)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_BODY_BYTES:
                self._write({"status": "error", "error_code": "invalid_body"}, 413)
                return
            request = json.loads(self.rfile.read(length))
            if not isinstance(request, dict):
                raise ValueError("JSON object required")
            payload, status = sdk_result(request, os.environ.get("EMQUANT_PYTHON_ROOT", os.getcwd()))
            self._write(payload, status)
        except Exception as exc:  # provider details remain server-side only
            self._write({"status": "provider_error", "error_code": "sidecar_error", "message": str(exc)[:240]}, 502)

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("[choice-sidecar] " + (fmt % args) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(description="Read-only Choice historical csd sidecar")
    parser.add_argument("--host", default=os.environ.get("CHOICE_SIDECAR_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("CHOICE_SIDECAR_PORT", "8787")))
    args = parser.parse_args()
    if not text(os.environ.get("CHOICE_SIDECAR_TOKEN")):
        raise SystemExit("Set CHOICE_SIDECAR_TOKEN to a separate bridge token before starting")
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Choice history sidecar listening on http://{args.host}:{args.port}/history (read-only)")
    server.serve_forever()


if __name__ == "__main__":
    main()
