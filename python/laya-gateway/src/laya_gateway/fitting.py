"""Exact, no-truncation fitting of ordered state candidates to one checkpoint's token limits."""

from dataclasses import dataclass

from .backend import Backend


@dataclass(frozen=True)
class Fitted:
    """The first candidate whose every question sequence fits without truncation."""

    index: int
    state_tokens: int
    sequence_tokens: list[int]
    padded_tokens: int


@dataclass(frozen=True)
class Unfit:
    """No candidate fits; `reason` names the capacity that refused it."""

    reason: str


def limits(backend: Backend, manifest_sha256: str) -> dict:
    """The wire token-limit record for this checkpoint."""
    return {
        "maxSequenceTokens": backend.max_len,
        "maxHeadTokens": backend.head_max_len,
        "maxBatchTokens": backend.max_len * backend.batch_size,
        "manifestSha256": manifest_sha256,
    }


def fit(backend: Backend, states: list[str], questions: dict[str, dict]) -> Fitted | Unfit:
    """Select the first state that fits every question sequence and the padded batch.

    Question heads are checked first: a head or option Laya would truncate is refused
    whatever the state. A candidate is skipped when any complete sequence exceeds
    `max_len`, or when its padded batch exceeds `max_len * batch_size`.
    """
    prefixes = []
    for definition in questions.values():
        length, reason = backend.prefix_tokens(definition)
        if reason is not None:
            return Unfit(reason)
        prefixes.append(length)
    max_batch = backend.max_len * backend.batch_size
    batch_refused = False
    for index, state in enumerate(states):
        state_tokens = backend.state_tokens(state)
        if state_tokens > backend.max_len:
            continue
        sequences = [prefix + state_tokens + 1 for prefix in prefixes]
        if any(length > backend.max_len for length in sequences):
            continue
        padded = max(sequences) * len(sequences) if sequences else 0
        if padded > max_batch:
            batch_refused = True
            continue
        return Fitted(index, state_tokens, sequences, padded)
    return Unfit("batch" if batch_refused else "state")
