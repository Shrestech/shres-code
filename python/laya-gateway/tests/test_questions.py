import pytest

from laya_gateway.questions import RequestError, to_laya_questions, to_wire_answer


def test_maps_every_question_kind_in_order():
    mapped = to_laya_questions([
        {"kind": "binary", "id": "b", "instructions": "Is it?", "criteria": {"yes": "Y", "no": "N"}},
        {"kind": "choice", "id": "c", "instructions": "Which?", "options": [{"option": "x"}, {"option": "y", "description": "why"}]},
        {"kind": "score", "id": "s", "instructions": "How hard?", "levels": ["low", "high"]},
    ])
    assert list(mapped) == ["b", "c", "s"]
    assert mapped["b"] == {"type": "noul", "instructions": "Is it?", "criteria": {"true": "Y", "false": "N"}}
    assert mapped["c"] == {"type": "choice", "instructions": "Which?", "criteria": {"x": None, "y": "why"}}
    assert mapped["s"] == {"type": "score", "instructions": "How hard?", "criteria": ["low", "high"]}


def test_binary_criteria_are_optional():
    mapped = to_laya_questions([{"kind": "binary", "id": "b", "instructions": "Is it?"}])
    assert mapped["b"]["criteria"] == {}


@pytest.mark.parametrize(
    "questions, message",
    [
        ("nope", "must be an array"),
        (["nope"], "must be an object"),
        ([{"kind": "binary", "instructions": "x"}], "non-empty string"),
        ([{"kind": "binary", "id": "a", "instructions": "x"}, {"kind": "binary", "id": "a", "instructions": "x"}], "repeated"),
        ([{"kind": "rank", "id": "a", "instructions": "x"}], "kind must be"),
        ([{"kind": "binary", "id": "a", "instructions": 3}], "instructions must be a string"),
        ([{"kind": "binary", "id": "a", "instructions": "x", "criteria": []}], "criteria must be an object"),
        ([{"kind": "choice", "id": "a", "instructions": "x", "options": [{"option": "only"}]}], "at least two options"),
        ([{"kind": "choice", "id": "a", "instructions": "x", "options": ["x", "y"]}], "options must be objects"),
        ([{"kind": "choice", "id": "a", "instructions": "x", "options": [{"option": "x"}, {"option": "x"}]}], "repeated"),
        ([{"kind": "score", "id": "a", "instructions": "x", "levels": ["one"]}], "at least two levels"),
    ],
)
def test_rejects_invalid_questions(questions, message):
    with pytest.raises(RequestError, match=message) as caught:
        to_laya_questions(questions)
    assert caught.value.status == 400


def test_answers_are_renormalized_and_scores_recomputed():
    choice = to_wire_answer("c", {"type": "choice", "criteria": {"x": None, "y": None, "z": None}}, {
        "choice": "x", "probabilities": {"x": 0.3334, "y": 0.3333, "z": 0.3334}, "confidence": 0.00001,
    })
    assert choice["option"] == "x"
    assert abs(sum(choice["probabilities"].values()) - 1) < 1e-5
    score = to_wire_answer("s", {"type": "score", "criteria": ["a", "b", "c"]}, {
        "score": 1.0, "probabilities": {"0": 0.2, "1": 0.2, "2": 0.6001}, "confidence": 0.3,
    })
    expected = sum(int(k) * v for k, v in score["probabilities"].items())
    assert score["score"] == pytest.approx(expected, abs=1e-5)
    binary = to_wire_answer("b", {"type": "noul", "criteria": {}}, {"noul": 0.25, "confidence": 0.75})
    assert binary == {"kind": "binary", "id": "b", "probability": 0.25}


def test_an_all_zero_distribution_is_refused():
    with pytest.raises(ValueError, match="all-zero"):
        to_wire_answer("c", {"type": "choice", "criteria": {"x": None, "y": None}}, {
            "choice": "x", "probabilities": {"x": 0, "y": 0}, "confidence": 0,
        })
