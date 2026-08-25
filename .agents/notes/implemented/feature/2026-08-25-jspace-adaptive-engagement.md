# Agent Note: J-Space adaptive engagement

Status: implemented

## Problem

The first live A/B pilot on the [W0 arm ladder](../../proposed/testing/2026-08-25-w0-harness-eval-arms-and-decision-rules.md) (experiment `w4-2026-08-25-zai-pilot`, Z.ai GLM-5.2, arms `off` / `on` / `on-sq`, 1 repeat, ~25 trials) priced the J-Space card for the first time. Every arm passed 100% of trials — the catalog is below a frontier model's floor, so the pilot carries no correctness signal — while `on` spent 2.9× the input tokens and 33% more turns than `off` for that identical outcome. The overhead was worst where the card is supposed to earn its keep: up to 5.4× input tokens on `compaction-stress-constraints`, the longest task in the set. `on-sq` was consistently cheaper than `on`, matching the PRO-LONG result (arXiv 2607.20064) that read-time history access substitutes for write-time note keeping.

The cost is structural, not incidental. `jspace-prompt` rendered its card, driver, and pass sections and `tool-jspace` shipped four tool schemas on every request from turn one, and the model then spent extra turns on note and checkpoint traffic. J-Space is insurance against long-horizon drift, and a session that ends in three turns has no drift to insure; the harness was charging every session the premium.

## Decision

The seat computes one per-session predicate, `ctx.jspace.engaged(session)`, and both Consumers read it. An active seat engages a session when either its card is already open or the session has closed at least `engageAfterTurns` turns. `jspace-prompt` returns empty text from every section while unengaged, including the automatic `loop` card open, so nothing latches engagement on the session's behalf. `tool-jspace` drops the four schemas from `assembly.tools` and denies a call that arrives anyway.

The open-card clause is resume safety, not an optimization: a card the model is already driving must never lose its driver or its tools because a fork reset the turn count or a deployment raised the threshold mid-session.

Both inputs are folds of the session log — the `turn/end` count and the `jspace/card` / `jspace/closed` fold — so engagement introduces no session event and the assembled request stays reconstructable from the log alone. `turn/end` lands once per closed turn whatever the end reason, so it counts the turns the model has lived through rather than the turns it succeeded at.

`engageAfterTurns` is a validated `Config` field on the seat, an integer at or above zero, defaulting to `0`. Zero engages from the first request, which is byte-for-byte the previous behavior; no shipped composition changes. Pre-release, the default may flip once the new `on-adaptive` bench arm (`on-sq` plus `engageAfterTurns: 10`) measures the trade against the same ladder.

### Tool gating is a real roster filter, not only a refusal

`ctx.tools` has no per-request roster hook, and the four registrations must stay mounted so an engaged session in the same process can execute them. The per-session decision therefore lands on the assembly that carries the session: `tool-jspace` joins the `system-prompt/assemble` waterfall, awaits `next()`, and removes the four names from `assembly.tools` when the session is unengaged. That assembly is what `agent-loop` hands to the provider, so the model genuinely never sees the schemas — no `agent-loop` change, and the listener is an ordinary documented extension point.

Prompt filtering alone is not enforcement, so the existing `tools/pre-execute` hook also denies a card tool from an unengaged session with `J-Space engages after <n> completed turns in this session; do the work directly until then.` The executor is where the denial is proved.

### Always-paid prompt mass

The four tool descriptions and the two tool-driver lines dropped from 1,845 to 1,481 characters (roughly 91 fewer tokens per engaged request) with every contract fact kept: epoch reset on a Goal change, `note` rejecting a Goal change, the coverage requirement, and the evidence-citation rule. The cuts are duplication — `jspace_open` and `jspace_note` restated their own parameter descriptions — plus filler. `jspace_checkpoint` now recommends citing an executed verifier call over describing the check in prose, which is both cheaper and the stronger evidence class. The closed-card driver asks for a Goal covering the work that remains, because under a non-zero threshold that line first appears partway through a session.

## Alternatives considered

**Remount the tool registrations per session.** Rejected: registration is process-wide and `watch()` carries the seat toggle, so a per-session remount would race concurrent agents in one process and hand one session's engagement to another.

**Refusal only, leaving the schemas visible.** Rejected as the primary mechanism: the schemas are most of the measured cost, so keeping them defeats the change. The refusal remains as the enforcement point behind the filter.

**Engage on a token or context-window threshold instead of a turn count.** Rejected for now: turn count is a direct fold of the log with no dependency on provider accounting, and the pilot's overhead tracked task length, which turns already proxy. A usage-based threshold can replace it once the adaptive arm shows the turn count mistargets.

**Default the threshold to a non-zero value in this change.** Rejected: the pilot measured cost, not benefit, on a catalog too easy to separate the arms. Flipping the default is a decision the `on-adaptive` arm is built to inform.

**Let the model decide when to open a card, with no threshold.** Rejected: the driver already asks for that and the pilot shows the model opening cards on short tasks anyway; the cost is paid in the prompt before the model chooses.

## Consequences

A deployment that sets `engageAfterTurns` pays nothing for J-Space on short sessions and gets the full card once a session runs long, at the price of one prefix invalidation on the request that crosses the threshold — four prompt sections and four tool schemas appear at once. A session that resumes with an open card keeps everything regardless of the threshold. `tool-jspace` gains type-only dependencies on `shres-code-system-prompt` and `shres-code-agent` for the assembly waterfall and its `agent` field.

The pilot's correctness column stays unanswered: no arm separated on pass rate, so nothing here claims the card fails to help — only that it currently charges every session as if it always does. No ACP or headless snapshot fixture pins the trimmed descriptions or the engagement refusal; recording one needs `DEEPSEEK_API_KEY`, which was unavailable, and the existing `jspace-tools` headless fixture carries neither the system prompt nor the tool schemas.
