# Agent Note: Step budget, repeat-call veto, and a registry-wide default tool timeout

Status: implemented

## Problem

A runtime survey of the harness found two ways a turn can run without any ceiling, both in `packages/guard/`.

Nothing bounded a turn. The agent loop iterates steps until the model stops asking for tools, the caller cancels, or the process dies; no plugin, config, or loop path capped that. The only backstop was `repeat-tool-reminder`, which is advisory by construction: at 3, 5, and 8 identical consecutive calls it injects text and always delegates, so a model that ignores the reminder repeats forever. A confused model therefore burns tokens and wall time until a human notices.

Nothing bounded a tool call either, in practice. `timeout-policy` arms a deadline only for a tool that declares `ToolDefinition.timeoutMs`, and the workhorse tools — `bash`, `read`, `write`, `edit` — declare none. Only `web_fetch` and `web_search` do. A hung `bash` stalls the turn with no deadline at all.

Both gaps are items 8 and 9 of the [harness-hardening plan](../../proposed/feature/2026-08-26-jspace-contract-and-harness-hardening.md), which prescribed exactly this shape: a guard plugin stopping the turn from an existing lifecycle extension point with a structured stop, the repeat guard escalated from reminder to veto, and a registry-wide default timeout that a tool's own declaration overrides.

## Decision

Three settings, all off in every shipped composition, so a deployment that changes nothing behaves exactly as before.

### `packages/guard/step-budget` — `maxStepsPerTurn`

A new guard counts nothing of its own. The loop already numbers every proposed step and resets at `turn/start`, and it passes that number to the `agent/pre-step` waterfall, so the guard rejects the first proposal past the budget and lets the loop close the turn.

The unit is the model step — one model request plus the tool calls it makes — and the scope is one turn. Per-session was considered and rejected below. `0` is the default and means unlimited; the plugin then registers no listener at all. A non-integer or negative value throws at plugin load.

Exhaustion does four things, in order:

1. Appends `step-budget/exhausted` (`{ turn, step, limit }`), a log-only event written `{ ignorable: true }` so a build without this guard still reads the log. `step` is always `limit + 1`: the step that was refused, not the last one that ran.
2. Returns the batch this pre-step already claimed to the inbox. The loop claims before running the waterfall, so a bare rejection would silently drop tool-result contexts and injected notices that no step ever consumed.
3. Queues the model-facing stop notice through `agent.inject()`. It names the limit, says the work is unfinished and nothing was cancelled, and asks for a one-or-two-sentence stocktake before more work, because the next turn resumes from a truncated middle.
4. Returns `{ kind: 'reject' }` without delegating, which the loop records as `turn/end` `{ kind: 'blocked' }`.

Rejecting at `agent/pre-step` is not a new code path: it is the same mechanism the Claude Code and Codex hook bridges use to deny a prompt. The guard adds no loop change and no new `TurnEndReason`.

A package-owned invariant folds the durable stream: a stop belongs to the turn it names, occurs at most once per turn, and sits one step past a positive budget.

### `repeat-tool-reminder` — `vetoThreshold`

The escalation lives in the package that already owns the chain, because a second copy of the chain-key and run-length logic in a different plugin would be the real cost. Default `0` means off — the shipped advisory-only behavior. A value below 2 or non-integer throws at load.

Once configured, a `tools/execute` listener reads the run length this attempt would reach and, from the threshold on, short-circuits the dispatch with a structured `REPEAT_TOOL_VETO` result instead of running the tool. The chain is still advanced in `tools/post-execute`, which a vetoed call also reaches, so the run keeps counting and every further identical call stays refused. Changing the tool or the arguments resets the chain and releases the veto.

It sits on `tools/execute` rather than the `tools/pre-execute` deny gate because a refusal the model or a metrics consumer can route on needs a structured error `code`, and a deny reason is prose.

### `timeout-policy` — `defaultTimeoutMs`

One validated number, absent by default. When set, it arms the existing cooperative deadline for a call whose tool declares no `timeoutMs`; the structured `TOOL_TIMEOUT` result is unchanged. A declaration wins in both directions — it raises a tool above a short fallback and holds a tool below a generous one — because the tool plugin knows its own work and the deployment does not. A non-positive or fractional value throws at load.

The package's `FIXME` about a `timeout-guard` rename is deliberately untouched.

## Alternatives considered

**Cancelling the agent instead of rejecting the step.** `agent.cancel()` exists and would stop the turn, but it ends it as `aborted` — the reason reserved for a caller or user cancelling — and it races an in-flight request rather than declining to start one. Rejection at `agent/pre-step` stops the turn at a quiet boundary and reads as what it is.

**A new `TurnEndReason` for the budget.** A `{ kind: 'budget' }` reason would be self-describing, but `TurnEndReason` is core loop vocabulary and a guard plugin adding to it inverts the dependency the plugin architecture exists to keep. `blocked` already means "a policy declined to continue", which is exactly the case, and the package-owned `step-budget/exhausted` event carries the detail a caller needs.

**Putting the detail in the turn end instead of a separate event.** Folding `{ turn, step, limit }` into the loop's own `turn/end` payload would need a core change and would make every reader of a common event carry this guard's vocabulary. A separate `ignorable` event keeps the cost on the deployments that mount the guard.

**Counting steps per session rather than per turn.** The loop publishes no session-lifetime step counter, so this guard would have to keep its own count in plugin memory — which restarts silently on resume or process restart. A cap that quietly forgets is worse than no cap. Per-turn is what the loop actually exposes and what a runaway tool loop grows.

**Shipping a non-zero default budget.** Any default is a guess about task mix, and a wrong guess truncates honest long work while looking like a bug. Unlimited by default keeps the change inert until a deployment opts in.

**Building the veto into the new guard instead of `repeat-tool-reminder`.** The chain key, the wildcard include/exclude predicates, the argument canonicalization, and the user-interjection reset already live in `repeat-tool-reminder`. Moving or duplicating them to give the veto a new home would cost more than the veto itself.

**Vetoing at `tools/pre-execute`.** The deny gate is the natural-looking place, but a deny carries a prose reason and no structured code, so a consumer would have to match refusal text. `tools/execute` short-circuiting returns a real `ToolExecutionResult` carrying `REPEAT_TOOL_VETO`.

**A per-tool override map in `timeout-policy` config.** A `{ bash: 120000, read: 5000 }` map would duplicate, in deployment config, the budget the tool plugin already owns and can validate. One fallback plus the tool's own declaration keeps a single home for each fact.

## Testing

`packages/guard/step-budget/tests/step-budget.spec.ts` drives a real agent loop against a scripted mock adapter: the turn ends `blocked` at the first step past the budget, the stop is recorded once with its coordinates and `ignorable`, before the loop's `turn/end`; the notice is queued once and enters the next turn's first step; a context the refused step had already claimed is pending again ahead of that notice; each turn gets a fresh budget; a turn inside its budget is untouched; the unlimited default registers no listener; disposal stops enforcement; and a negative or fractional budget throws at load. `tests/invariant.spec.ts` covers the durable fold, including a violating stop already present in a loaded log.

`repeat-tool-reminder`'s suite adds the veto: off by default, refusing from the threshold on with `REPEAT_TOOL_VETO`, never running the vetoed tool, releasing when the model changes the call, leaving untracked tools and agent-less direct calls alone, and failing loud below 2. `timeout-policy`'s suite adds the fallback arming an undeclared tool, a declaration winning over it, the unconfigured plugin leaving an undeclared tool untouched, and loud failure on a non-positive or fractional value.

The keyless ACP scenario `guard-step-budget` pins the assembled transcript: the `guard-budget.cordis.yml` overlay turns the veto on at 4 and caps the turn at 5 steps, and an authored replay script repeats one `todo_write` until both fire. It pins the advisory reminder at 3, the structured refusal at 4 and 5 with no `todo/write` behind them, the `step-budget/exhausted` stop, the `blocked` turn end, and the stop notice arriving as the next turn's first context. The base composition is unchanged, so no other scenario moves.

## Consequences

Every enforcing behavior here is inert until configured, which is what makes the change safe to land mid-eval — and also means no shipped composition is protected yet. Choosing the numbers is a separate decision that wants measurement, not a default picked here.

A stopped turn is a stop, not a summary. The turn ends where it stood; the guard neither compacts nor checkpoints, and recovery depends on the next turn reading its own log. The budget also cannot be raised for one legitimately long turn: it is deployment config, and no tool or session state relaxes it.

The veto is per-agent and in-memory, like the chain it reads, so a resumed session starts with an empty chain and a repeat run spanning a restart is not detected.

`defaultTimeoutMs` has no definition-level opt-out, which item 9 of the plan asks for. The registry rejects a non-positive `ToolDefinition.timeoutMs`, so "never deadline me" currently has no spelling and would need a new field in `packages/core/tools`. A deployment that configures the fallback therefore also covers the filesystem tools, whose package [refuses file-IO deadlines](../../../../packages/fs/README.md#no-timeouts-on-file-io) on the grounds that a deadline kills work the OS will still finish. Nothing ships armed, so that recorded decision stands unless a deployment overrides it deliberately; the opt-out stays with the plan note.
