"""Map Shield-wire questions to Laya question definitions and Laya answers back to the wire."""

from typing import Any


class RequestError(Exception):
    """A request the gateway refuses; carries the HTTP status to send."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


_KINDS = ("binary", "choice", "score")
_DECIMALS = 6


def _string(value: Any, name: str) -> str:
    if not isinstance(value, str):
        raise RequestError(400, f"{name} must be a string")
    return value


def to_laya_questions(questions: Any) -> dict[str, dict]:
    """Validate wire questions and return Laya definitions keyed by question id, in order."""
    if not isinstance(questions, list):
        raise RequestError(400, "questions must be an array")
    result: dict[str, dict] = {}
    for index, question in enumerate(questions):
        if not isinstance(question, dict):
            raise RequestError(400, f"questions[{index}] must be an object")
        qid = question.get("id")
        if not isinstance(qid, str) or not qid:
            raise RequestError(400, f"questions[{index}].id must be a non-empty string")
        if qid in result:
            raise RequestError(400, f"question id {qid!r} is repeated")
        kind = question.get("kind")
        if kind not in _KINDS:
            raise RequestError(400, f"question {qid!r} kind must be one of {', '.join(_KINDS)}")
        instructions = _string(question.get("instructions"), f"question {qid!r} instructions")
        if kind == "binary":
            criteria = question.get("criteria")
            if criteria is None:
                criteria = {}
            if not isinstance(criteria, dict):
                raise RequestError(400, f"question {qid!r} criteria must be an object")
            mapped = {}
            if criteria.get("yes") is not None:
                mapped["true"] = _string(criteria["yes"], f"question {qid!r} criteria.yes")
            if criteria.get("no") is not None:
                mapped["false"] = _string(criteria["no"], f"question {qid!r} criteria.no")
            result[qid] = {"type": "noul", "instructions": instructions, "criteria": mapped}
        elif kind == "choice":
            options = question.get("options")
            if not isinstance(options, list) or len(options) < 2:
                raise RequestError(400, f"question {qid!r} needs at least two options")
            criteria: dict[str, Any] = {}
            for option in options:
                if not isinstance(option, dict):
                    raise RequestError(400, f"question {qid!r} options must be objects")
                label = _string(option.get("option"), f"question {qid!r} option")
                if not label or label in criteria:
                    raise RequestError(400, f"question {qid!r} option {label!r} is empty or repeated")
                description = option.get("description")
                criteria[label] = None if description is None else _string(
                    description, f"question {qid!r} option {label!r} description"
                )
            result[qid] = {"type": "choice", "instructions": instructions, "criteria": criteria}
        else:
            levels = question.get("levels")
            if not isinstance(levels, list) or len(levels) < 2:
                raise RequestError(400, f"question {qid!r} needs at least two levels")
            result[qid] = {
                "type": "score",
                "instructions": instructions,
                "criteria": [_string(level, f"question {qid!r} level") for level in levels],
            }
    return result


def _normalized(probabilities: dict[str, float], keys: list[str]) -> dict[str, float]:
    """Renormalize Laya's four-decimal probabilities so the wire sum is exact to rounding."""
    values = [float(probabilities[key]) for key in keys]
    total = sum(values)
    if not total > 0:
        raise ValueError("model returned an all-zero distribution")
    return {key: round(value / total, _DECIMALS) for key, value in zip(keys, values)}


def to_wire_answer(qid: str, definition: dict, answer: dict) -> dict:
    """Convert one Laya answer into the Shield-wire answer for the same question."""
    confidence = round(float(answer["confidence"]), _DECIMALS)
    kind = definition["type"]
    if kind == "noul":
        return {"kind": "binary", "id": qid, "probability": round(float(answer["noul"]), _DECIMALS)}
    if kind == "choice":
        keys = list(definition["criteria"])
        probabilities = _normalized(answer["probabilities"], keys)
        return {
            "kind": "choice",
            "id": qid,
            "option": answer["choice"],
            "probabilities": probabilities,
            "confidence": confidence,
        }
    keys = [str(index) for index in range(len(definition["criteria"]))]
    probabilities = _normalized(answer["probabilities"], keys)
    score = round(sum(index * probabilities[key] for index, key in enumerate(keys)), _DECIMALS)
    return {
        "kind": "score",
        "id": qid,
        "score": score,
        "probabilities": probabilities,
        "confidence": confidence,
    }
