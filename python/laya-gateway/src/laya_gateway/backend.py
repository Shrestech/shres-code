"""Model backends: the operations the gateway needs, and the MLX Laya implementation."""

from pathlib import Path
from typing import Protocol

OPTION_TOKEN_CAP = 48
"""Tokens of one option's text Laya keeps; a longer option is truncated upstream."""


class Backend(Protocol):
    """Token accounting and inference over one loaded checkpoint."""

    max_len: int
    """Maximum complete question-plus-state sequence length."""
    head_max_len: int
    """Maximum question-and-options head length."""
    batch_size: int
    """Questions per inference batch."""

    def prefix_tokens(self, definition: dict) -> tuple[int, str | None]:
        """Return the question head's token count and `option`/`head` when Laya would truncate it."""
        ...

    def state_tokens(self, state: str) -> int:
        """Return the state's token count as Laya tokenizes it."""
        ...

    def sequence_tokens(self, state: str, questions: dict[str, dict]) -> list[int]:
        """Return the complete sequence length Laya builds for each question."""
        ...

    def predict(self, state: str, questions: dict[str, dict]) -> dict[str, dict]:
        """Return Laya answers keyed by question id."""
        ...


class MlxLayaBackend:
    """A Laya checkpoint loaded through laya-mlx. Importing this module does not import MLX."""

    def __init__(self, model_dir: Path, dtype: str, batch_size: int):
        import laya_mlx
        from laya_mlx import common

        self._common = common
        self.agent = laya_mlx.load(str(model_dir), dtype=dtype, batch_size=batch_size)
        self.max_len = int(self.agent.cfg.get("max_len", 512))
        self.head_max_len = int(self.agent.cfg.get("head_max_len", 192))
        self.batch_size = batch_size

    def _internal(self, definition: dict) -> dict:
        # laya-mlx is pinned exactly (==0.2.0), so its question normaliser is a stable API here.
        return self.agent._to_internal(definition)

    def prefix_tokens(self, definition: dict) -> tuple[int, str | None]:
        common, tok = self._common, self.agent.tok
        question = self._internal(definition)
        built, _markers = common.build_prefix(tok, question, self.head_max_len)
        mask = tok.mask_token
        head = tok("%s question: %s" % (question["t"], str(question["ins"]).replace(mask, " ")))[
            "input_ids"
        ]
        options = [
            tok(" " + text.replace(mask, " "))["input_ids"] for text in common.render_options(question)
        ]
        untruncated = [tok.cls_token_id, *head, tok.sep_token_id]
        for option in options:
            untruncated += [tok.mask_token_id, *option]
        untruncated.append(tok.sep_token_id)
        if built == untruncated:
            return len(built), None
        if any(len(option) > OPTION_TOKEN_CAP for option in options):
            return len(built), "option"
        return len(built), "head"

    def state_tokens(self, state: str) -> int:
        tok = self.agent.tok
        text = self._common.serialize_state(state).replace(tok.mask_token, " ")
        return len(tok(text)["input_ids"])

    def sequence_tokens(self, state: str, questions: dict[str, dict]) -> list[int]:
        items, _internal = self.agent.prepare(state, questions)
        return [len(item["ids"]) for item in items]

    def predict(self, state: str, questions: dict[str, dict]) -> dict[str, dict]:
        return self.agent.predict(state, questions)["answers"]
