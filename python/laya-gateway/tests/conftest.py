import http.client
import json
import threading

import pytest

from laya_gateway.server import GatewayServer, GatewayState

MODEL_ID = "owner/stub@" + "a" * 40
MANIFEST_SHA = "b" * 64


class StubBackend:
    """Deterministic backend: whitespace tokens, a fixed prompt shape, fixed answers."""

    def __init__(self, max_len=64, head_max_len=24, batch_size=4, option_cap=6):
        self.max_len = max_len
        self.head_max_len = head_max_len
        self.batch_size = batch_size
        self.option_cap = option_cap
        self.predictions = 0

    @staticmethod
    def _options(definition):
        criteria = definition["criteria"]
        if definition["type"] == "choice":
            return [key if value is None else f"{key}: {value}" for key, value in criteria.items()]
        if definition["type"] == "score":
            return [f"level {index}: {level}" for index, level in enumerate(criteria)]
        return [f"false: {criteria.get('false', 'no')}", f"true: {criteria.get('true', 'yes')}"]

    def prefix_tokens(self, definition):
        options = [len(text.split()) for text in self._options(definition)]
        length = 3 + len(definition["instructions"].split()) + sum(1 + n for n in options)
        if any(n > self.option_cap for n in options):
            return length, "option"
        if length > self.head_max_len:
            return length, "head"
        return length, None

    def state_tokens(self, state):
        return len(state.split())

    def sequence_tokens(self, state, questions):
        return [self.prefix_tokens(d)[0] + self.state_tokens(state) + 1 for d in questions.values()]

    def predict(self, state, questions):
        self.predictions += 1
        answers = {}
        for qid, definition in questions.items():
            if definition["type"] == "noul":
                answers[qid] = {"type": "noul", "noul": 0.25, "confidence": 0.75}
            elif definition["type"] == "choice":
                labels = list(definition["criteria"])
                rest = round(0.3 / (len(labels) - 1), 4)
                probabilities = {label: (0.7 if i == 0 else rest) for i, label in enumerate(labels)}
                answers[qid] = {"type": "choice", "choice": labels[0], "probabilities": probabilities, "confidence": 0.41}
            else:
                levels = len(definition["criteria"])
                probabilities = {str(i): round(1 / levels, 4) for i in range(levels)}
                answers[qid] = {"type": "score", "score": 1.5, "probabilities": probabilities, "confidence": 0.2}
        return answers


@pytest.fixture
def backend():
    return StubBackend()


@pytest.fixture
def gateway(backend):
    state = GatewayState(backend, MODEL_ID, MANIFEST_SHA, max_request_bytes=4096)
    server = GatewayServer(state, 0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)


def request(server, method, path, body=None, headers=None):
    """Send one request and return (status, parsed JSON body)."""
    connection = http.client.HTTPConnection("127.0.0.1", server.port, timeout=5)
    payload = None if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
    base = {"host": f"127.0.0.1:{server.port}"}
    if payload is not None:
        base["content-type"] = "application/json"
        base["content-length"] = str(len(payload))
    base.update(headers or {})
    connection.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
    for name, value in base.items():
        if value is not None:
            connection.putheader(name, value)
    connection.endheaders(payload)
    response = connection.getresponse()
    data = response.read()
    connection.close()
    return response.status, json.loads(data) if data else None
