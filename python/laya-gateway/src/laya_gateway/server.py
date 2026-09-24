"""Loopback HTTP server for the Shield judgment wire.

Requests and responses follow `@shres-code/shres-code-judgment-shield`. The server
binds 127.0.0.1 only, requires a JSON content type (so a browser cannot send a
simple cross-origin request), checks the Host header against its own address,
never logs request bodies, and serializes inference behind one lock.
"""

import json
import sys
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import ENGINE
from .backend import Backend
from .fitting import Fitted, fit, limits
from .questions import RequestError, to_laya_questions, to_wire_answer

HOST = "127.0.0.1"


@dataclass
class GatewayState:
    """What every request handler reads: the backend, identity, limits, and inference lock."""

    backend: Backend
    model_id: str
    manifest_sha256: str
    max_request_bytes: int
    lock: threading.Lock = field(default_factory=threading.Lock)

    @property
    def limits(self) -> dict:
        return limits(self.backend, self.manifest_sha256)


def _answers(state: GatewayState, text: str, questions: dict[str, dict]) -> tuple[list[dict], float]:
    """Run inference once and return wire answers in question order plus the latency."""
    if not questions:
        return [], 0.0
    started = time.perf_counter()
    raw = state.backend.predict(text, questions)
    latency = (time.perf_counter() - started) * 1000
    return [to_wire_answer(qid, definition, raw[qid]) for qid, definition in questions.items()], latency


def _envelope(state: GatewayState, answers: list[dict], latency_ms: float) -> dict:
    return {"engine": ENGINE, "model": state.model_id, "latencyMs": round(latency_ms, 3), "answers": answers}


def _require_model(state: GatewayState, body: dict) -> None:
    if body.get("model") != state.model_id:
        raise RequestError(409, f"this gateway serves {state.model_id}")


def handle_judgment(state: GatewayState, body: dict) -> dict:
    """Answer `POST /v1/judgments`. Over-long state is truncated exactly as upstream Laya does."""
    _require_model(state, body)
    text = body.get("state")
    if not isinstance(text, str):
        raise RequestError(400, "state must be a string")
    questions = to_laya_questions(body.get("questions"))
    with state.lock:
        answers, latency = _answers(state, text, questions)
    return _envelope(state, answers, latency)


def handle_fitted(state: GatewayState, body: dict) -> dict:
    """Answer `POST /v1/judgments/fitted`: judge the first candidate that fits without truncation."""
    _require_model(state, body)
    states = body.get("states")
    if not isinstance(states, list) or not states or not all(isinstance(s, str) for s in states):
        raise RequestError(400, "states must be a non-empty array of strings")
    questions = to_laya_questions(body.get("questions"))
    limit_record = state.limits
    with state.lock:
        outcome = fit(state.backend, states, questions)
        if not isinstance(outcome, Fitted):
            return {
                "kind": "unfit",
                "engine": ENGINE,
                "model": state.model_id,
                "reason": outcome.reason,
                "limits": limit_record,
            }
        selected = states[outcome.index]
        if questions and state.backend.sequence_tokens(selected, questions) != outcome.sequence_tokens:
            raise RuntimeError("measured sequence lengths differ from the inference input")
        answers, latency = _answers(state, selected, questions)
    return {
        "kind": "answered",
        "fit": {
            "selectedIndex": outcome.index,
            "stateTokens": outcome.state_tokens,
            "sequenceTokens": outcome.sequence_tokens,
            "paddedTokens": outcome.padded_tokens,
            "limits": limit_record,
        },
        "result": _envelope(state, answers, latency),
    }


class GatewayServer(ThreadingHTTPServer):
    """A ThreadingHTTPServer that carries the gateway state and its own Host allowlist."""

    daemon_threads = True

    def __init__(self, state: GatewayState, port: int):
        self.state = state
        super().__init__((HOST, port), _Handler)
        bound = self.server_address[1]
        self.port = bound
        self.allowed_hosts = {f"{HOST}:{bound}", f"localhost:{bound}"}


class _Handler(BaseHTTPRequestHandler):
    server: GatewayServer
    protocol_version = "HTTP/1.1"
    server_version = "shres-laya-gateway"

    def log_message(self, format, *args):  # noqa: A002 -- BaseHTTPRequestHandler signature
        """Request lines and bodies may carry conversation text; nothing is logged per request."""

    def _send(self, status: int, payload: dict) -> None:
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _refuse_host(self) -> bool:
        if self.headers.get("host") not in self.server.allowed_hosts:
            self._send(421, {"error": "unexpected Host header"})
            return True
        return False

    def do_GET(self):
        if self._refuse_host():
            return
        if self.path != "/healthz":
            self._send(404, {"error": "not found"})
            return
        state = self.server.state
        self._send(200, {"ok": True, "model": state.model_id, "manifestSha256": state.manifest_sha256})

    def do_POST(self):
        if self._refuse_host():
            return
        routes = {"/v1/judgments": handle_judgment, "/v1/judgments/fitted": handle_fitted}
        handler = routes.get(self.path)
        if handler is None:
            self._send(404, {"error": "not found"})
            return
        try:
            body = self._read_json()
            self._send(200, handler(self.server.state, body))
        except RequestError as error:
            self._send(error.status, {"error": str(error)})
        except ValueError as error:
            # laya-mlx reports an unanswerable question definition as ValueError.
            self._send(400, {"error": str(error)})
        except Exception as error:  # noqa: BLE001 -- any other failure is an internal 500
            print(f"laya-gateway: {self.path} failed: {type(error).__name__}: {error}", file=sys.stderr)
            self._send(500, {"error": "internal error"})

    def _read_json(self) -> dict:
        content_type = (self.headers.get("content-type") or "").split(";")[0].strip().lower()
        if content_type != "application/json":
            raise RequestError(415, "content-type must be application/json")
        length = self.headers.get("content-length")
        if length is None or not length.isdigit():
            raise RequestError(411, "content-length is required")
        size = int(length)
        if size > self.server.state.max_request_bytes:
            raise RequestError(413, f"request exceeds {self.server.state.max_request_bytes} bytes")
        try:
            body = json.loads(self.rfile.read(size).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise RequestError(400, f"request is not UTF-8 JSON: {error}") from error
        if not isinstance(body, dict):
            raise RequestError(400, "request is not a JSON object")
        return body
