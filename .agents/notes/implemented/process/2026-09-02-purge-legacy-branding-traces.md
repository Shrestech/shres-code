# Agent Note: Purge legacy-branding traces

Status: implemented

## Problem

The rebrand to Shres Code left residue the brand gate could not see. `verify-no-legacy-brand` flagged uppercase `ROOS_[A-Z]`, `@roos-code`, and `DeepSeek Harness`, but missed lowercase `roos_` shell variables, standalone `dsh` comments and fixture ids, the `/home/.dsh` path, the retired python package dir `deepseek_harness_runtime`, and `dsh-` prefixed note filenames. `.gitignore` still carried two dead `deepseek_harness_runtime` paths, and the gate keep-lists in both `verify-no-legacy-brand.ts` and `rebrand.ts` flagged two legitimate web tests that name the retired identity to assert it is absent, so `hygiene` stayed red on its own gates.

## Decision

Remove the residue and widen the gate so it cannot return, keeping the live DeepSeek LLM provider untouched.

- `verify-no-legacy-brand.ts` gains forbidden patterns for `roos_` lowercase shell vars, standalone `DSH`, the `/home/.dsh` path, the `dsh-tool-skill` fixture, and `deepseek_harness_runtime`, and its `DeepSeek[- ]Harness` rule covers hyphenated and case-varied forms.
- Both `verify-no-legacy-brand.ts` and `rebrand.ts` keep-list `apps/web/tests/brand-rebrand.e2e.ts`, `apps/web/tests/verify-app.live.mjs`, and (gate only) `scripts/verify-public-repository-links.spec.ts`, which legitimately name the retired identity to prove it is gone.
- `.gitignore` drops the stale `deepseek_harness_runtime` paths (the dir is now `shres_code_runtime`).
- E2B internal shell variables rename `roos_` to `shres_` (no external contract).
- One `dsh` comment, one `/home/.dsh` fixture path, one `dsh-tool-skill` fixture id, and two "deepseek harness" search-query fixtures are neutralized.
- Five active note files with `dsh-`/`roos-` prefixes rename to neutral slugs and their live cross-links update; the `shres-code-review` skill title and one proposed note vendoring rationale no longer name the retired upstream. Decision records are preserved by renaming, not deleted.

The DeepSeek LLM provider (`llm-deepseek`, `web-search-deepseek`, `DEEPSEEK_API_KEY`, `deepseek.com`) is live product, not residue, and is left alone.

## Alternatives considered

**Hard-delete the old-world notes.** Rejected: all five are current decision records (the `roos-product-chrome` note is actually about Shres chrome); renaming removes the trace while preserving rationale per the note-archiving rules.

**Add a filename-path check to the gate.** Rejected: archived notes legitimately keep `dsh-` in frozen filenames, so a path rule could not distinguish those from active residue without complexity; the rename removes the trace directly.

**Broaden the brand gate to every `dsh`/`roos` substring.** Rejected: over-broad rules would flag legitimate keep-listed provenance (NOTICE, rebrand notes, vendor) and test fixtures; targeted patterns cover the actual residue.

## Consequences

`hygiene`'s `verify-no-legacy-brand` and `rebrand:check` gates pass. The residue cannot regress without failing the gate. Active note filenames and fixtures no longer carry the retired `dsh`/`roos` identities. The full `hygiene` aggregate still fails on pre-existing, unrelated knip findings in test fixtures, confirmed present on a clean checkout before this change.