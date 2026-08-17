# Agent Note: Untrusted frame util for remote model-visible text

Status: implemented


## Problem

Untrusted text reaches the model from more than one consumer. Cross-session snapshots, fetched pages, and search answers or snippets can all contain instructions, permission claims, or tool-shaped requests that the current user did not write. A payload can also spell an XML-like closing tag and break out of whatever wrapper the consumer thought it owned.

`shres-session-reference` already solved this for one caller: a trusted label that says not to follow instructions inside the payload, XML-like tags around the data, and lossless `<` → `\u003c` escaping so source text cannot close those tags. Web fetch and search rendered provider text with no equivalent wrapper. The next consumer (project-sourced skills) would have copied the same three pieces again, and the copies would drift.

## Decision

`@shres-code/shres-code-untrusted-frame` lives under `packages/util/` and owns the mechanical wrapper only. It is a library of pure functions, **not** a Cordis service or plugin: it takes no `ctx`, registers nothing, holds no state, and emits no events.

The library exports `escapeUntrusted`, `stringifyTagSafeJson`, `wrapUntrusted`, `frameUntrusted`, the shared disclaimer `UNTRUSTED_INSTRUCTION_DISCLAIMER`, and the `\u003c` replacement `UNTRUSTED_LT_ESCAPE`. A caller chooses the tag name and the label's first sentence, then keeps trusted metadata outside the frame.

Current callers:

- `shres-session-reference` frames the JSON snapshot as `<referenced-sessions>`. The model-visible bytes are unchanged from the previous inlined prefix and suffix.
- `shres-tool-web` `web_fetch` frames the decoded page as `<untrusted-web-page>`. The `Fetched <url> (HTTP <status>)` header and the truncation footer stay outside.
- `shres-tool-web` `web_search` emits the shared disclaimer once when an answer or any source is present, wraps the answer in `<untrusted-web-answer>`, and wraps each snippet in `<untrusted-web-snippet>`. Source titles, URLs, dates, the refine-the-query note, and the cite instruction stay outside.
- `shres-skill` `renderSkillContent` places the shared disclaimer inside `<skill_content>` for untrusted sources and wraps the instruction body with `wrapUntrusted`. Trusted sources reuse `UNTRUSTED_LT_ESCAPE` to neutralize a close-tag family. See the [skill framing Agent Note](2026-08-16-skill-body-escaping-trust-framing.md).

`stringifyTagSafeJson` remains the JSON form of the same escape so session-reference byte budgets still measure the framed payload.

## Alternatives considered

**Duplicate the session-reference prefix and escape in `shres-tool-web`.** Rejected because the next untrusted consumer would copy it again, and a later change to the disclaimer or escape would not reach every site.

**Warn in the system prompt only, without escaping.** Rejected because a payload that contains `</untrusted-web-page>` still closes the wrapper; a prompt sentence cannot restore a broken frame.

**HTML-escape the whole payload, or strip tags.** Rejected because it changes more characters than needed to prevent a frame breakout. The session-reference JSON form already required a lossless escape that `JSON.parse` can invert.

**Summarize or rewrite remote text with an LLM before showing it.** Rejected on cost and because the summary would still need a frame.

## Consequences

- Fetched pages and search answers/snippets grow by the disclaimer and tags; every payload `<` becomes the six-character `\u003c` escape. Markdown conversion still runs before the fetch frame, so ordinary converted pages rarely contain `<`.
- A `fetchMaxOutputChars` cap that can hold the status header, an empty frame, and the truncation footer always closes `</untrusted-web-page>` before the footer. A tinier cap still slices the finished string, including tags.
- Session-reference snapshots keep their previous bytes; only the import path changed.
- Project-sourced skills reuse the disclaimer and `wrapUntrusted` on the instruction body; they keep their own `<skill_content>` tags rather than calling `frameUntrusted` on the whole block.
