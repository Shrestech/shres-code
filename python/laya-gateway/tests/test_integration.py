"""Real laya-mlx checks; skipped unless LAYA_GATEWAY_MODEL_DIR names an installed checkpoint."""

import os
from pathlib import Path

import pytest

from laya_gateway.fitting import Fitted, fit
from laya_gateway.questions import to_laya_questions

MODEL_DIR = os.environ.get("LAYA_GATEWAY_MODEL_DIR")
pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(MODEL_DIR is None, reason="LAYA_GATEWAY_MODEL_DIR is not set"),
]


@pytest.fixture(scope="module")
def backend():
    from laya_gateway.backend import MlxLayaBackend

    return MlxLayaBackend(Path(MODEL_DIR), "float16", 16)


def test_measured_fit_equals_the_inference_input(backend):
    questions = to_laya_questions([
        {"kind": "choice", "id": "route", "instructions": "Which route should handle this turn?",
         "options": [{"option": "keep-current"}, {"option": "flash", "description": "small edits"}]},
        {"kind": "score", "id": "difficulty", "instructions": "How hard is this turn?",
         "levels": ["routine", "moderate", "involved", "hard", "very hard"]},
    ])
    state = "Rename the variable total to sum in utils.py."
    result = fit(backend, [state], questions)
    assert isinstance(result, Fitted)
    assert backend.sequence_tokens(state, questions) == result.sequence_tokens
    answers = backend.predict(state, questions)
    assert set(answers) == {"route", "difficulty"}


def test_an_overlong_option_is_reported_not_truncated(backend):
    questions = to_laya_questions([
        {"kind": "choice", "id": "q", "instructions": "Pick",
         "options": [{"option": "a", "description": "word " * 80}, {"option": "b"}]},
    ])
    assert fit(backend, ["x"], questions).reason == "option"
