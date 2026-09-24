# @shres-code/shres-code-progress-signals

Pure progress-signal folds over a session's committed events: five stuck-trigger verdicts, the numbers-first progress facts that measure the same runs, the trailing tool window, and the identical-call chain key. Each fold reads only the log it is given, so resume, fork, compaction, and bench replay reach the same answers from the same events.

It is a **library, not a service or plugin**: no `ctx`, registers nothing, holds no state, emits no events. [`worker-escalation`](../worker-escalation/README.md) folds a worker's log through it for the difficulty ladder, and any other consumer reads the same verdicts without depending on the Team packages. The [extraction Agent Note](../../../.agents/notes/implemented/architecture/2026-09-24-progress-signals-extraction.md) records why the folds have their own home.

## API

| Export | Role |
|---|---|
| `foldEscalationTriggers(events, triggers, epochAnchorSeq?)` | One verdict per trigger, in `ESCALATION_TRIGGERS` order; a fired verdict names the newest event that satisfies it. |
| `foldProgressFacts(events, triggers, epochAnchorSeq?)` | Tool outcome counts, the identical-call chain in force, distinct failed approaches, and completed steps since the progress floor. |
| `triggerSatisfiedAt(events, triggerSeq, trigger)` | Whether the event at `triggerSeq` is the kind of event `trigger` counts: the config-free half of the trigger contract a consumer's invariant checks a logged verdict against. |
| `foldToolWindow(events, maxTools)` | Trailing answered tool calls, oldest-first, capped at `maxTools`; a call still in flight is not part of the window. |
| `probeInFlight(events)` | Whether a call that registers a probed charter check has not received its own result yet. |
| `callChainKey(name, rawArguments)`, `canonicalizeArguments(raw)` | The call identity the repeat-tool-reminder guard keys its chain on: the tool name and the deep key-sorted arguments, or the raw string when the arguments are not JSON. |
| `isSandboxDenial(code, text)` | Whether one tool result is a sandbox policy denial rather than a failed approach. |
| `ESCALATION_TRIGGERS` | The trigger vocabulary, in verdict order. |

A trigger row is `{ enabled, threshold }` (`ResolvedEscalationTrigger`), and the folds take one row per trigger (`ResolvedEscalationTriggers`). This package owns no defaults and no validation: each consumer resolves its own table from its own configuration.

## Triggers

A fired verdict reports the newest event that satisfies its trigger at the fold point, so a standing condition keeps pointing at fresh evidence rather than at the moment it began. A trigger that measures failures treats a sandbox policy denial and a charter-discrimination probe run as transparent: they neither count nor reset the run, because the harness's own refusals are not approaches the session chose. A probe run is dispatched inside the call that registered the probed check, and that call's own result lands after the run's markers, so a consumer takes no verdict while `probeInFlight` holds: the exclusion is read from the log rather than from the order its records arrive in.

| Trigger | Fires when | Scope |
|---|---|---|
| `errorBurst` | Consecutive errored tool-sourced results reach the threshold. | Whole log. |
| `attemptCount` | Distinct failed approaches reach the threshold — one per distinct `[tool, canonical arguments]` chain key. | The epoch, restarted at the newest passing charter checkpoint or ship run. |
| `repeatRunLength` | An identical-call chain reaches the threshold, keyed exactly as the repeat-tool-reminder guard keys it. | Whole log; a source-`user` message resets the chain. |
| `stepBudgetExhausted` | `step-budget/exhausted` records reach the threshold. | The epoch. |
| `turnFailureStreak` | Consecutive durable `turn/end` failures reach the threshold. | Whole log; any other turn end resets the streak. |

A durable turn failure is an `error` reason whose code is neither `ABORTED` nor `UNKNOWN` — the same taxonomy model-routing's route-failure fold counts. A sandbox denial is recognized by the structured `FS_SANDBOX_DENIED` code or by the rendered `[sandbox: file access denied under <mode> mode]` marker, which are the two carriers the enforcing tool families produce.

The epoch is the caller's `epochAnchorSeq`, an exclusive lower bound; `-1` folds the whole log. Its progress floor is the anchor, advanced to the newest passing charter `checkpoint` or `ship` run after it, because verified progress clears the failures before it. `attemptCount` and the facts' `stepsSinceCheckpoint` count from that floor.

## Progress facts

`foldProgressFacts` reports every count from the same fold that fires the trigger it measures, at the row's own threshold, so a reported number and a firing verdict cannot drift apart. Enablement is deliberately not read: a disabled row still measures, because the facts are evidence about the session rather than a verdict on it. The facts are counts only; no tool text is part of them.

## Model Experience

Indirectly, through worker-escalation, whose Lead report renders the tool window and whose judgment ask renders the progress facts; this library renders no text of its own.

#### KV Cache effect

The folds make no model request and write no event, so they neither extend nor invalidate any cached prefix; a consumer's rendered text carries its own cache effect.

## Known Limitations and Deferred Work

- **The durable-failure taxonomy is restated** — model-routing's route-failure predicate is private to that package, so `turnFailureStreak` restates it: a failure a recovery listener absorbs without scheduling a retry leaves no `turn/end` error, a throw the harness flattens to `UNKNOWN` is not attributable, a crash-orphaned turn closes as `interrupted`, and auxiliary calls never log a failure — none of them advances the streak.
- **A denial carried only as prose counts as a failure** — a confining provider that reports neither `FS_SANDBOX_DENIED` nor the rendered marker is counted by `errorBurst` and `attemptCount` as a failed approach.
- **Every fold re-reads the log it is given** — each call passes over the complete event array, so a consumer that evaluates on every committed event pays one pass per evaluation; incremental folding is deferred until a consumer measures that cost.
