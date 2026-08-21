# Agent Note: Session-log tool-call failures were avoidable rejects

Status: implemented

## Problem

A review of prior session logs surfaced two tool-call failure families that a model could not avoid except by guessing magic words, wasting a round trip each time.

`jspace_checkpoint` rejected valid coverage claims. `checkpoint()` refuses a `by` string that matches none of a short built-in coverage-term list (`coverage`, `verifier`, `test`, `tests`, `unit`, `checked`, `cases`, `suite`, `including`). Models write prose claims such as `"direct source reads: git show d7eabfb diff; grep redeem across src"` or `"bash git-history scan covering roe.py"`; these fail once, and only a keyword-stuffed rewrite (`Verifier: … Coverage: …`) passes. The rejection message ("jspace checkpoint requires a verifier and coverage claim") did not say what would satisfy it.

`ask_user_question` hard-failed when the model sent a question without an `id`. The schema marked `id` required, but the id only serves as an answer-correlation key; a model that omits it (as in a logged 3-question call) gets `invalid arguments: missing required property "questions[N].id"` for the whole batch.

## Decision

Broaden `DEFAULT_COVERAGE_TERMS` in `packages/jspace/jspace/src/fold.ts` with verification-method words models actually emit and their grammatical siblings: `covered`, `covering`, `verify`, `verifies`, `verified`, `tested`, `check`, `checks`, `scan`, `scanned`, `grep`, `grepped`, `read`, `reads`, `diff`, `diffed`. Whole-word matching (`[^\\p{L}\\p{N}_]` boundaries) already keeps compounds like `test_http_app_target.py` from matching `test`.

Make the coverage rejection teach the fix. `packages/jspace/jspace/src/index.ts` now appends to the stable prefix: `: state in \`by\` who verified and what they covered, for example "vitest run of fold.spec.ts green; direct read of index.ts lines 360-392"`.

Make `ask_user_question` tolerant of omitted ids. `packages/interaction/tool-ask-user/src/index.ts` drops `id` from the item's `required` list and assigns the first free `q<n>` to each omitted id through `resolveServiceQuestions`, so generated ids never collide with a provided one and every answer still correlates.

## Alternatives considered

**Only grow the term list.** Rejected: the failure cost is not just the reject but the model guessing what satisfies it. Teaching the shape in the rejection message removes both, and tests now pin the exact prose the real sessions produced.

**Restructure `by` into separate verifier/coverage fields.** Rejected: the Checked line is free prose (`✓n check — by`), and changing the wire shape is a larger contract change than the observed failures warrant. The term heuristic stays a soft guardrail against empty claims.

**Keep `id` required in `ask_user_question` and rely on the description.** Rejected: it is exactly the failure observed — the tool rejects valid input for a field that only correlates answers.

## Consequences

`checkpoint()` accepts concrete verification prose without keyword scaffolding, so legitimate coverage claims stop burning a rejected call. `ask_user_question` accepts questions with or without ids, defaulting them deterministically. Model-visible text changed in both tools and is updated in `docs/tool-catalog.md`, the tool-jspace README, and the authored ACP tool-schema snapshot; `SESSION_FORMAT_VERSION` is untouched because only model-facing schema prose changed.
