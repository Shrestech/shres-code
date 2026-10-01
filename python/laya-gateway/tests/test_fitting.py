from laya_gateway.fitting import Fitted, Unfit, fit, limits

from .conftest import StubBackend


def choice(instructions="Pick one", options=("a", "b")):
    return {"type": "choice", "instructions": instructions, "criteria": dict.fromkeys(options)}


def test_selects_the_first_fitting_state_without_truncation():
    backend = StubBackend(max_len=20)
    questions = {"q": choice()}
    prefix = backend.prefix_tokens(questions["q"])[0]
    long_state = " ".join(["w"] * (20 - prefix))
    short_state = " ".join(["w"] * 3)
    result = fit(backend, [long_state, short_state], questions)
    assert isinstance(result, Fitted)
    assert result.index == 1
    assert result.sequence_tokens == [prefix + 3 + 1]
    assert result.padded_tokens == prefix + 4


def test_exact_boundary_fits():
    backend = StubBackend(max_len=20)
    questions = {"q": choice()}
    prefix = backend.prefix_tokens(questions["q"])[0]
    result = fit(backend, [" ".join(["w"] * (20 - prefix - 1))], questions)
    assert isinstance(result, Fitted) and result.sequence_tokens == [20]


def test_state_reason_when_nothing_fits():
    backend = StubBackend(max_len=12)
    result = fit(backend, [" ".join(["w"] * 30), " ".join(["w"] * 13)], {"q": choice()})
    assert result == Unfit("state")


def test_head_and_option_reasons_refuse_before_any_state():
    backend = StubBackend(max_len=100, head_max_len=8)
    assert fit(backend, ["x"], {"q": choice("a very long instruction indeed")}) == Unfit("head")
    wide = StubBackend(max_len=100, head_max_len=100, option_cap=2)
    assert fit(wide, ["x"], {"q": choice(options=("one two three", "b"))}) == Unfit("option")


def test_batch_reason_when_only_the_padded_batch_overflows():
    backend = StubBackend(max_len=40, head_max_len=40, batch_size=1)
    questions = {"q1": choice(), "q2": choice()}
    state = " ".join(["w"] * 15)
    sequence = backend.prefix_tokens(questions["q1"])[0] + 15 + 1
    assert sequence <= 40 < sequence * 2
    assert fit(backend, [state], questions) == Unfit("batch")


def test_zero_questions_select_the_first_state_that_fits_alone():
    backend = StubBackend(max_len=5)
    result = fit(backend, ["a b c d e f", "a b"], {})
    assert result == Fitted(1, 2, [], 0)


def test_limits_record():
    assert limits(StubBackend(max_len=64, head_max_len=24, batch_size=4), "f" * 64) == {
        "maxSequenceTokens": 64, "maxHeadTokens": 24, "maxBatchTokens": 256, "manifestSha256": "f" * 64,
    }
