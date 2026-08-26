# Agent Note: Subagent concurrency cap and out-of-process start-option enforcement

Status: implemented

## Problem

A parent can start as many one-shot and continuable children as the model asks for. [`maxParallelToolCalls`](2026-08-09-parallel-subagent-delegations.md) caps only the unsettled tool calls of one step, so background and continuable children keep running after their start call settles. Nothing on `ctx.subagents` refused a later spawn.

Out-of-process providers accepted `maxDepth`, `toolFilter`, and `outputSchema` on `SubagentStartRequest` and then ignored them: they advertised `NO_START_CAPABILITIES` (all false) while callers still passed the fields, and some paths never ran `assertStartCapabilities` on a direct `provider.start()`. Item 12 of the [harness-hardening plan](../../proposed/feature/2026-08-26-jspace-contract-and-harness-hardening.md) names both gaps.

## Decision

### Spawn occupancy lives on `SubagentRuntime`

`maxConcurrentSubagents` is Service Definition config on `@shres-code/shres-code-subagent`, not on `shres-tool-subagent`. Every caller — the delegation tool, workflow/ralph, and a direct `ctx.subagents.start()` — shares one counter. A Consumer-level cap would miss those other entry points.

The field is `number | 'unlimited'`. Default `'unlimited'` preserves today's unbounded admission. `'unlimited'` is the explicit unlimited value; `0` is invalid and throws at plugin load or at a constructor that bypasses schemastery. A positive safe integer is the occupied-slot ceiling.

A slot is occupied by a published one-shot run until its `dispose()` settles, and by a first-epoch continuable Activation until that epoch settles or rolls back. Follow-up and cold resume do not occupy. Admission increments synchronously before any `provider.start()` or `prepareContinuable` await, so two concurrent `start()` calls at `cap - 1` cannot both pass. At the cap the call throws `SubagentError` `CONCURRENCY_CAP` naming the ceiling and the live count. The refused call is not queued.

### Parent-side `maxDepth`; honor or reject the rest per wire

`SubagentRuntime.start()` always runs `assertStartCapabilities` before occupancy. Out-of-process providers call it again at the top of `provider.start()` so a direct provider call cannot accept-then-ignore. Production remote backends advertise `REMOTE_START_CAPABILITIES` (`depthLimit: true`, the rest false). `NO_START_CAPABILITIES` remains the all-false fixture.

| Option | Out-of-process | Why |
|---|---|---|
| `maxDepth` | Honor on every provider | `resolveChildDepth(parent, maxDepth)` already exists on the parent. A numeric cap now means the same parent-side refusal as in-process. Nested agents inside Claude, Codex, Grok, Kimi, ACP, or a child harness stay those products' concern. Shipped tool YAML may still set `maxDepth: 'provider-managed'` to omit the cap. |
| `outputSchema` | Honor on `claude-code` only | The Claude Agent SDK accepts `outputFormat: { type: 'json_schema', schema }` and returns `structured_output`. ACP, Codex, Grok, Kimi, and the SDK child have no equivalent one-shot contract. |
| `toolFilter` | Reject on every out-of-process provider | There is no shared tool-name vocabulary. Claude `allowedTools` is not harness `bash` / `read`. Mapping would silently change which tools the child actually has. |
| `persona` | Reject (unchanged) | Out of this item's scope; still `UNSUPPORTED_CAPABILITY`. |

A rejected option throws `UNSUPPORTED_CAPABILITY` with `subagent provider "<name>" does not support <option>` before spawn.

## Alternatives considered

**Cap on `shres-tool-subagent`.** Rejected: workflow, ralph, and direct `ctx.subagents.start()` would bypass it.

**Queue at the cap.** Rejected: this seam has no queue. Silent waiting would look like a hung spawn.

**Magic `0` for unlimited.** Rejected: `0` already means "forbid delegation" on `maxDepth`. `'unlimited'` is the explicit value.

**Reject `maxDepth` on every remote provider.** Rejected: parent-side `resolveChildDepth` is the same check in-process already uses, and it does not require the child process.

**Map `toolFilter` onto Claude `allowedTools`.** Rejected: the names do not match, so a "honor" path would still be a silent different filter.

**Honor `outputSchema` by asking every CLI for JSON mode.** Rejected: those products do not expose a harness-schema contract comparable to Claude's `structured_output`. Loud reject is the honest failure.

## Testing

`packages/subagent/subagent/tests/service.spec.ts` covers the cap: default unlimited, explicit `'unlimited'`, at-cap refusal with cap and live count, concurrent admission during a hanging start, slot release on a start rejection, and load/constructor failure for `0` / `-1` / `1.5`. `continuation.spec.ts` covers `startContinuable` at cap, release on settlement, and release on rollback.

`out-of-process.spec.ts` pins `REMOTE_START_CAPABILITIES` and `assertStartCapabilities`. Each remote provider suite plus its Loader composition e2e pins advertised flags and proves `maxDepth: 0` is `SubagentDepthError` (not `UNSUPPORTED_CAPABILITY`) while `toolFilter` and `outputSchema` reject before spawn — except `claude-code`, which forwards `outputSchema` as SDK `outputFormat` and copies `structured_output` onto `SubagentResult.structured`.

Cap refusal text can reach the model as an errored `subagent` tool result. Existing keyless snapshots `subagent-parallel` and `subagent-continuable` use the unlimited default and stay valid. No snapshot pins a cap refusal; a new scenario would need a composition overlay that sets `maxConcurrentSubagents`, which this change does not add.

## Consequences

Default compositions behave as before. A deployment that sets a positive cap refuses further one-shot starts and first-epoch continuable Activations until a slot is released; forgotten `dispose()` holds the slot. `maxParallelToolCalls` still caps one step's unsettled tool calls; this cap counts live children across steps.

A numeric `maxDepth` on an out-of-process tool instance now mounts, because those providers advertise `depthLimit`. It still does not bound recursion inside the remote product. `toolFilter` / `outputSchema` (except Claude Code) / `persona` on those providers fail at spawn instead of disappearing.
