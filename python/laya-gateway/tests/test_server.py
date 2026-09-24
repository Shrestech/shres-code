from .conftest import MANIFEST_SHA, MODEL_ID, request

QUESTIONS = [
    {"kind": "choice", "id": "route", "instructions": "Which route?", "options": [{"option": "keep-current"}, {"option": "flash"}]},
    {"kind": "score", "id": "difficulty", "instructions": "How hard?", "levels": ["easy", "medium", "hard"]},
    {"kind": "binary", "id": "safe", "instructions": "Is it safe?"},
]


def test_healthz_reports_identity(gateway):
    assert request(gateway, "GET", "/healthz") == (200, {"ok": True, "model": MODEL_ID, "manifestSha256": MANIFEST_SHA})


def test_judgment_answers_every_question_in_order(gateway, backend):
    status, body = request(gateway, "POST", "/v1/judgments", {"state": "hi", "model": MODEL_ID, "questions": QUESTIONS})
    assert status == 200
    assert body["engine"] == "shield" and body["model"] == MODEL_ID and body["latencyMs"] >= 0
    assert [a["id"] for a in body["answers"]] == ["route", "difficulty", "safe"]
    assert [a["kind"] for a in body["answers"]] == ["choice", "score", "binary"]
    assert backend.predictions == 1


def test_judgment_without_questions_runs_no_inference(gateway, backend):
    status, body = request(gateway, "POST", "/v1/judgments", {"state": "hi", "model": MODEL_ID, "questions": []})
    assert status == 200 and body["answers"] == [] and backend.predictions == 0


def test_fitted_answers_the_selected_state(gateway):
    status, body = request(gateway, "POST", "/v1/judgments/fitted", {
        "states": [" ".join(["w"] * 200), "short state"], "model": MODEL_ID, "questions": QUESTIONS[:1],
    })
    assert status == 200 and body["kind"] == "answered"
    fit = body["fit"]
    assert fit["selectedIndex"] == 1 and fit["stateTokens"] == 2
    assert fit["paddedTokens"] == max(fit["sequenceTokens"]) * len(fit["sequenceTokens"])
    assert fit["limits"]["manifestSha256"] == MANIFEST_SHA
    assert body["result"]["answers"][0]["id"] == "route"


def test_fitted_unfit_runs_no_inference(gateway, backend):
    status, body = request(gateway, "POST", "/v1/judgments/fitted", {
        "states": [" ".join(["w"] * 200)], "model": MODEL_ID, "questions": QUESTIONS[:1],
    })
    assert status == 200
    assert body == {"kind": "unfit", "engine": "shield", "model": MODEL_ID, "reason": "state", "limits": body["limits"]}
    assert backend.predictions == 0


def test_fitted_refuses_a_measurement_that_disagrees_with_inference(gateway, backend):
    backend.sequence_tokens = lambda state, questions: [999]
    status, body = request(gateway, "POST", "/v1/judgments/fitted", {"states": ["s"], "model": MODEL_ID, "questions": QUESTIONS[:1]})
    assert status == 500 and body == {"error": "internal error"}
    assert backend.predictions == 0


def test_request_validation(gateway):
    assert request(gateway, "POST", "/v1/judgments", {"state": "x", "model": "other", "questions": []})[0] == 409
    assert request(gateway, "POST", "/v1/judgments", {"state": 1, "model": MODEL_ID, "questions": []})[0] == 400
    assert request(gateway, "POST", "/v1/judgments/fitted", {"states": [], "model": MODEL_ID, "questions": []})[0] == 400
    assert request(gateway, "POST", "/v1/judgments", b"[1]")[0] == 400
    assert request(gateway, "POST", "/v1/judgments", b"{")[0] == 400
    assert request(gateway, "POST", "/v1/judgments", {"state": "x"}, {"content-type": "text/plain"})[0] == 415
    assert request(gateway, "POST", "/v1/judgments", b"x" * 5000)[0] == 413
    assert request(gateway, "POST", "/nope", {})[0] == 404
    assert request(gateway, "GET", "/nope")[0] == 404


def test_missing_length_and_foreign_host_are_refused(gateway):
    assert request(gateway, "POST", "/v1/judgments", b"{}", {"content-length": None})[0] == 411
    assert request(gateway, "GET", "/healthz", headers={"host": "evil.example:80"})[0] == 421
    assert request(gateway, "POST", "/v1/judgments", {"state": "x"}, {"host": "evil.example:80"})[0] == 421


def test_upstream_question_errors_are_400(gateway, backend):
    def refuse(state, questions):
        raise ValueError("Question 'route' has too many options for the token budget")
    backend.predict = refuse
    status, body = request(gateway, "POST", "/v1/judgments", {"state": "x", "model": MODEL_ID, "questions": QUESTIONS[:1]})
    assert status == 400 and "too many options" in body["error"]
