# @shres-code/shres-code-worker-escalation

Deterministic stuck detection for delegated worker sessions, with a judgment engine as an observer on top. A delegation child cannot ask the human (the caller is delegated), the step budget bounds one turn rather than a session, and the jspace advisor engages root sessions only — so a worker that cannot make progress has no structured response at all. This package folds the worker's own log for five stuck signals, records one log-only `escalation/decision` per firing trigger, and after `maxContinues` continue resolutions on a goal epoch reports the worker blocked to the Lead through the mailbox the worker already owns.

Stage 1 consults an optional judgment engine for every continue resolution: one two-option choice ask, gated on the answer's confidence and its top-two probability margin, logged with the engine class, the gate outcome, and the answer's own figures. Nothing executes on that answer — a `needs-help` choice is a record — and the report-blocked terminal stays the ladder's one action. It appears in no default bundle row, and `enabled: false` writes no session event, sends no mail, and makes no ask, so a composed-but-off deployment is byte-identical to one without this package.

## Config

Every field is validated at plugin load (and again for a settings write), unknown keys fail by name, and the cross-field requirements fail too: `enabled: true` with every trigger row disabled is refused, because a ladder that can never fire is a silent no-op.

| Key | Default | Effect |
|---|---|---|
| `enabled` | `false` | Master allow. Off means no session event and no mail, ever. |
| `triggers.errorBurst.enabled` | `true` | Whether the consecutive-failure trigger may fire. |
| `triggers.errorBurst.burst` | `2` | Consecutive errored tool results that count as a burst. |
| `triggers.attemptCount.enabled` | `true` | Whether the distinct-failed-approaches trigger may fire. |
| `triggers.attemptCount.attempts` | `3` | Distinct failed approaches on the goal epoch that count as stuck. |
| `triggers.repeatRunLength.enabled` | `true` | Whether the identical-call trigger may fire. |
| `triggers.repeatRunLength.runLength` | `3` | Identical-call chain length that counts as stuck. |
| `triggers.stepBudgetExhausted.enabled` | `true` | Whether the step-budget trigger may fire. |
| `triggers.stepBudgetExhausted.exhaustions` | `1` | Step-budget stops on the epoch that count as stuck. |
| `triggers.turnFailureStreak.enabled` | `true` | Whether the durable-failure trigger may fire. |
| `triggers.turnFailureStreak.streak` | `2` | Consecutive durable turn failures that count as stuck. |
| `maxContinues` | `3` | Continue resolutions one goal epoch may take before the terminal. `0` reports at the first firing trigger. |
| `maxArbiterDepth` | `1` | Delegation depth the ladder engages within; must be at least 1 because root sessions are never engaged. |
| `minStepsBetween` | `2` | Completed steps between two decisions on one session. `0` removes the cooldown. |
| `maxDigestTools` | `12` | Trailing `tool/call` signals the report's digest and the Stage 1 state's tool window retain. |
| `maxDigestChars` | `4000` | Character cap on the rendered digest and on the Stage 1 state, and the total budget for retained later team mail. |
| `maxExcerptChars` | `200` | Character cap on each bounded excerpt: an error, the assignment, and each later team message. |
| `maxArgChars` | `80` | Character cap on each tool-argument excerpt. |
| `progressInstructions` | — | Instructions of the Stage 1 ask's choice question. Required: the judgment engine owns no prose, so a composition that omits it fails at load. |
| `confidence` | `0.8` | Confidence the ask's answer must reach for its gate to pass. |
| `margin` | `0.1` | Top-two probability margin (`top1 - top2`) the answer must reach for its gate to pass. |
| `judgmentTier` | `accurate` | Tier the ask runs at: `fast` or `accurate`. |

The trigger defaults follow their owning packages: `burst` matches the advisor's error-burst default, `runLength` matches the repeat-tool-reminder guard's first threshold, and `streak` matches model-routing's durable route-failure streak. The two gates default to model-routing's operating points, which stay provisional until a labeled stuck-worker set exists.

## Composition

```yaml
- name: '@shres-code/shres-code-worker-escalation'
  config:
    enabled: true
    maxContinues: 3
    minStepsBetween: 2
    triggers:
      stepBudgetExhausted:
        enabled: false
```

The package registers the `worker-escalation` settings namespace so a deployment can flip `enabled` without editing its composition; the namespace is deliberately outside the Settings plane's product allowlist, so it is not exposed through the Web proxy.

## Triggers

Each verdict reports the newest event that satisfies its trigger, so a standing condition keeps pointing at fresh evidence rather than at the moment it began. A trigger that measures failures treats a sandbox policy denial and a charter-discrimination probe run as transparent: they neither count nor reset the run, because the harness's own refusals are not approaches the worker chose. A probe run is dispatched inside the call that registered the probed check, and that call's own result lands after the run's markers, so no verdict is taken while the registering call is open: the exclusion is read from the log rather than from the order its records arrive in.

| Trigger | Fires on | Scope |
|---|---|---|
| `errorBurst` | Consecutive errored tool-sourced results reaching `burst`. | Whole log. |
| `attemptCount` | `attempts` distinct failed approaches — one per distinct `[tool, canonical arguments]` chain key. | The goal epoch, restarted at the newest passing charter checkpoint or ship run. |
| `repeatRunLength` | An identical-call chain reaching `runLength`, keyed exactly as the repeat-tool-reminder guard keys it. | Whole log; a source-`user` message resets the chain. |
| `stepBudgetExhausted` | `exhaustions` `step-budget/exhausted` records on the epoch. | The goal epoch. |
| `turnFailureStreak` | Consecutive durable `turn/end` failures reaching `streak`. | Whole log; any other turn end resets the streak. |

A durable turn failure is an `error` reason whose code is neither `ABORTED` nor `UNKNOWN` — the same taxonomy model-routing's route-failure trigger counts. A sandbox denial is recognized by the structured `FS_SANDBOX_DENIED` code or by the rendered `[sandbox: file access denied under <mode> mode]` marker, which are the two carriers the enforcing tool families produce.

The goal epoch's anchor is the jspace card's own `goalOpenedSeq`; without an open card the ladder folds the whole log. The `attemptCount` window then restarts at the newest passing charter `checkpoint` or `ship` run, because verified progress clears the failures before it.

## Decisions and the terminal

One `escalation/decision` is appended per resolved trigger, log-only and `ignorable`. It records the trigger and its seq, the choice, the engine class, the reason, the aging state, and the answer's confidence and margin where an engine answered. Any decision that is not the terminal records the aging state after itself — the epoch's resolution count including this decision, and this decision's own seq as the newest — which is what makes a `needs-help` choice a continue resolution. After `maxContinues` of them on one goal epoch, the next firing trigger resolves `report-blocked` instead: the worker mails the Lead a `team_send` report (the fixed preamble plus the bounded digest) and then records the terminal with `reason: 'max-continues'` and no engine class, because that rule resolves before any consult runs. The terminal is one-shot per epoch.

Two gates sit in front of every decision. The session must be a delegation child within `maxArbiterDepth` — a root session carries no delegation depth and is never engaged — and `minStepsBetween` completed steps must have passed since the previous decision. Neither gate reads mail: a worker that had to wait for the Lead to write before it could decide would deadlock on exactly the situation the ladder exists for.

An evaluation runs from a microtask scheduled by the committed event that changed a verdict, never inside that event's publication window: `Session.append` refuses to reenter while another append is published.

## The judgment consult

The ladder reaches the judgment engine through a structural `ctx.get('judgment')` read with no declared injection, so a composition carries an engine or does not. One ask is made per firing trigger that is still a continue resolution — the deterministic terminal makes none — carrying the numbers-first state, one choice question whose options are `continue` and `needs-help`, and the configured tier.

The gate passes only when the answer's confidence is at or above `confidence` and the top-two margin of its distribution is at or above `margin`. A passed gate logs the ask's own option, so a `needs-help` choice appears on the decision and executes nothing. Every other outcome degrades to the Stage 0 continue, carrying the class that caused it:

| `engine` | `reason` | Cause |
|---|---|---|
| `absent` | `engine-absent` | No judgment engine is composed. |
| `disabled` | `engine-disabled` | An engine is composed and the Definition's `judgment` settings section reads `enabled: false`. |
| `unavailable` | `engine-unavailable` | The ask threw — an unreachable engine, a refusal, an aborted or timed-out ask. |
| `invalid-answer` | `invalid-answer` | The answer was missing, of another kind, or named an option the question does not carry. |
| `ok` | `low-confidence` | The engine answered, and its confidence is below the gate. |
| `ok` | `thin-margin` | The engine answered, and its top-two margin is below the gate. |

The ladder passes the numbers-first state to `ctx.judgment` unredacted and never reads `ctx.judgmentRedactor`: when a deployment mounts that hook, consulting it exactly once per ask is the provider's obligation ([judgment README](../../llm/judgment/README.md#redaction-hook)). The engine's toggle is not read while the ladder is off, so an off deployment makes no ask. The state is numbers-first: the tool-outcome counts, the goal epoch's distinct failed approaches, the identical-call chain in force, the completed steps since the progress floor, and one `ok`|`FAIL` line per trailing call. It composes no excerpt of any kind — neither the error nor the argument excerpt the Lead's report carries — and no Config switch turns either on, because those excerpts are workspace-derived text. A decision carries `confidence` and `margin` only where an engine answered, which the `./invariant` companion asserts.

## Anchors

The digest anchors on the Lead's assignment: the first delivered team message — a `user/message` whose source kind is `team-message`, which the human-message fold drops — plus the latest logged card's charter, then a bounded window of completed steps and trailing tool outcomes. A delegated worker's conversation holds no human message, so anchoring on one would produce an empty digest.

## Model Experience

### Blocked report to the Lead

#### What the model sees

One user-role message in the Lead's conversation, sent with `team_send` when a worker reaches its terminal: the fixed preamble naming the trigger, its `triggerSeq`, and the continue count, followed by the rendered digest (the assignment, the charter, later team mail, the step count, and trailing tool outcomes). The worker's own conversation receives nothing — `escalation/decision` is log-only and this package registers no prompt section, tool, or injected notice.

#### Token effect

Fixed and terminal-only: at most one report per goal epoch, bounded by `maxDigestChars` plus the preamble, and only for the Lead's conversation. Every other decision costs nothing, because a log-only event is never part of a request.

#### KV Cache effect

The report is appended to the Lead's conversation, so it grows that prefix append-only and invalidates nothing already reused there. The worker's conversation prefix is untouched: the ladder writes no message into it.

### Stage 1 judgment ask

#### What the model sees

One request to the judgment engine per continue resolution: `state` — the numbers-first worker state, which this package passes unredacted and the provider passes through `ctx.judgmentRedactor` when a deployment mounts one ([judgment README](../../llm/judgment/README.md#redaction-hook)) — plus the question's own text: the configured `progressInstructions` and its `continue` and `needs-help` options. The engine answers the highest-probability option with a probability per option and a confidence figure. No conversation model sees this text, and nothing the ask returns reaches the worker's conversation or the Lead's.

#### Token effect

The state and the question text are the ask's input, charged at the engine's own rate, and the answer is its output. The state is bounded by `maxDigestChars`, with the tool window capped at `maxDigestTools`, and it carries no text beyond the configured question, the counts, and one line per trailing tool. One ask happens per continue resolution, so a worker whose triggers keep firing asks once per cooldown window. Nothing about an ask enters a conversation, so the ladder's own context cost is zero.

#### KV Cache effect

Independent model request: the ask neither reads nor extends the worker's conversation prefix, and nothing about it enters a later request. Repeating an identical state may reuse the engine's own prefix cache, which that provider owns.

## Known Limitations and Deferred Work

- **The ladder acts only through the terminal** — continue resolutions are logged and never delivered, and the Stage 1 consult observes: a `needs-help` choice is a record, so a stuck worker keeps working unchanged until it reports blocked. The rungs that make a consult observable to the worker are a later stage.
- **The terminal makes no ask** — the epoch's `maxContinues` rule resolves before any consult runs, so the one firing trigger that reports the worker blocked contributes no labeled answer.
- **The gates are provisional, and the tier is an alias** — `confidence` and `margin` default to model-routing's measured operating points rather than a labeled stuck-worker set, and `judgmentTier` names a seam tier that a provider resolves to a model id, so two tiers resolving to one model are not distinguishable from the decision alone.
- **A slow engine serializes one session's decisions** — one evaluation runs per session at a time and each waits for its ask, so an engine that takes seconds delays that session's next decision. The ask carries the ladder's lifetime signal, and a provider bounds it with its own timeout.
- **The durable-failure taxonomy is restated, and it degrades loudly** — model-routing's route-failure predicate is private to that package, so `turnFailureStreak` restates it: a failure a recovery listener absorbs without scheduling a retry leaves no `turn/end` error, a throw the harness flattens to `UNKNOWN` is not attributable, a crash-orphaned turn closes as `interrupted`, and auxiliary calls never log a failure — none of them advances the streak.
- **A report the mailbox refuses is not recorded** — the terminal decision is appended only after `team_send` accepts the report, so the epoch stays open and a later firing trigger retries it. A worker that is not a Team member (no `agentTeams`, or no roster entry) can therefore never reach the terminal: it keeps logging continues until `maxContinues`, then logs nothing further and warns once per cooldown window.
- **Epoch scoping needs the jspace card** — `attemptCount` and `stepBudgetExhausted` anchor on `goalOpenedSeq` and fall back to the whole log without an open card. A worker composition without the jspace seat loses the epoch boundary, not the trigger.
- **A single hung step never reaches another decision** — the cooldown counts `step/end` events, so a worker stuck inside one step is invisible to `minStepsBetween`. A wall-clock cooldown is deferred because it would make the fold non-deterministic on replay.
- **A denial carried only as prose counts as a failure** — a confining provider that reports neither `FS_SANDBOX_DENIED` nor the rendered marker is counted by `errorBurst` and `attemptCount` as a failed approach.
- **The digest retains mail under the digest cap** — later team messages share `maxDigestChars` with the render rather than owning a cap of their own, so a long steering history elides older mail first and reports the count.
