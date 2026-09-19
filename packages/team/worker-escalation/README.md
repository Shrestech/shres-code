# @shres-code/shres-code-worker-escalation

Stage 0 of the worker difficulty ladder: deterministic stuck detection for delegated worker sessions. A delegation child cannot ask the human (the caller is delegated), the step budget bounds one turn rather than a session, and the jspace advisor engages root sessions only — so a worker that cannot make progress has no structured response at all. This package folds the worker's own log for five stuck signals, records one log-only `escalation/decision` per firing trigger, and after `maxContinues` continue resolutions on a goal epoch reports the worker blocked to the Lead through the mailbox the worker already owns.

It is engine-free: every decision it writes carries `engine: 'absent'`, and nothing beyond the report is executed. It appears in no default bundle row, and `enabled: false` writes no session event and sends no mail, so a composed-but-off deployment is byte-identical to one without this package.

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
| `maxDigestTools` | `12` | Trailing `tool/call` signals the report's digest retains. |
| `maxDigestChars` | `4000` | Character cap on the rendered digest, and the total budget for retained later team mail. |
| `maxExcerptChars` | `200` | Character cap on each bounded excerpt: an error, the assignment, and each later team message. |
| `maxArgChars` | `80` | Character cap on each tool-argument excerpt. |

The trigger defaults follow their owning packages: `burst` matches the advisor's error-burst default, `runLength` matches the repeat-tool-reminder guard's first threshold, and `streak` matches model-routing's durable route-failure streak.

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

One `escalation/decision` is appended per resolved trigger, log-only and `ignorable`. A `continue` records the aging state after itself — the epoch's continue count including this decision, and this decision's own seq as the newest continue. After `maxContinues` continues on one goal epoch, the next firing trigger resolves `report-blocked` instead: the worker mails the Lead a `team_send` report (the fixed preamble plus the bounded digest) and then records the terminal. The terminal is one-shot per epoch.

Two gates sit in front of every decision. The session must be a delegation child within `maxArbiterDepth` — a root session carries no delegation depth and is never engaged — and `minStepsBetween` completed steps must have passed since the previous decision. Neither gate reads mail: a worker that had to wait for the Lead to write before it could decide would deadlock on exactly the situation the ladder exists for.

An evaluation runs from a microtask scheduled by the committed event that changed a verdict, never inside that event's publication window: `Session.append` refuses to reenter while another append is published.

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

## Known Limitations and Deferred Work

- **Stage 0 acts only through the terminal** — the ladder's continue resolutions are logged and never delivered, so a stuck worker keeps working unchanged until it reports blocked. The judgment rungs that make a decision observable to the worker are a later stage.
- **The durable-failure taxonomy is restated, and it degrades loudly** — model-routing's route-failure predicate is private to that package, so `turnFailureStreak` restates it: a failure a recovery listener absorbs without scheduling a retry leaves no `turn/end` error, a throw the harness flattens to `UNKNOWN` is not attributable, a crash-orphaned turn closes as `interrupted`, and auxiliary calls never log a failure — none of them advances the streak.
- **A report the mailbox refuses is not recorded** — the terminal decision is appended only after `team_send` accepts the report, so the epoch stays open and a later firing trigger retries it. A worker that is not a Team member (no `agentTeams`, or no roster entry) can therefore never reach the terminal: it keeps logging continues until `maxContinues`, then logs nothing further and warns once per cooldown window.
- **Epoch scoping needs the jspace card** — `attemptCount` and `stepBudgetExhausted` anchor on `goalOpenedSeq` and fall back to the whole log without an open card. A worker composition without the jspace seat loses the epoch boundary, not the trigger.
- **A single hung step never reaches another decision** — the cooldown counts `step/end` events, so a worker stuck inside one step is invisible to `minStepsBetween`. A wall-clock cooldown is deferred because it would make the fold non-deterministic on replay.
- **A denial carried only as prose counts as a failure** — a confining provider that reports neither `FS_SANDBOX_DENIED` nor the rendered marker is counted by `errorBurst` and `attemptCount` as a failed approach.
- **The digest retains mail under the digest cap** — later team messages share `maxDigestChars` with the render rather than owning a cap of their own, so a long steering history elides older mail first and reports the count.
