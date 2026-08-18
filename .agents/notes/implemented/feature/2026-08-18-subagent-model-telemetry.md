# Agent Note: Subagent model telemetry and effective-route inheritance

Status: implemented

## Problem

A dogfood session (`session-4e7bbd4a`, SHRES-Root, 2026-08-18) delegated three reviews to subagents and then could not answer "which agents ran, on what models?" The parent session log records only the child id and the child's output: the provider and model live solely in the child's own session file, `list_agents` prints id/status/label, and the main agent — asked directly — correctly reported it had no way to know.

The same session exposed two routing defects underneath the observability gap. The `standard` preset mounts a generic `subagent` tool with no model binding while the user's `agent-seats` bindings (aegis/stride/ward in the `agent-seats` settings namespace) are consumed only by the `agent-seats` plugin, which no CLI preset mounted — so the seat tools never existed and the model could not have used them. And the children that did run inherited `deepseek-v4-flash` from the parent's creation-time `AgentOptions` while the parent's requests ran `deepseek-v4-pro` via `agent-default-model` selection: `resolveChildAgentOptions` cloned `parent.options`, not the parent's effective model, so every model switch silently misrouted every later child.

## Decision

**Route inheritance reads the parent's effective model.** `resolveChildAgentOptions` (`subagent/src/child-agent.ts`) now resolves the child's provider/model through `effectiveChildRoute`: per-child request overrides, else the parent's logged request header, else the live `agentDefaultModel` default (opportunistic `ctx.get`, type-only import, same pattern as the sandbox/approval/preset lookups beside it), else the parent's creation options. The read is non-installing — it never attaches selection listeners to the parent. `maxTokens` still inherits from creation options.

**The spawn seam reports the route it will run.** The `subagent` tool's continuable and foreground results carry optional `provider`/`model` fields, the continuable render reads `started subagent <id> (provider/model)`, and the continuable descriptor's existing `agentProvider`/`agentModel` fields are populated from the same `effectiveChildRoute` call instead of raw `parent.options`, so the durable descriptor reports what the child actually runs. `list_agents` appends `(provider/model)` to a child row from the child's logged request header — a storage-only child that never made a request shows no route.

**Seats are mounted host-plane.** The `agent-seats` plugin is a row in the base bundle (`packages/bundle/base/cordis.patch.yml`), beside the jspace rows; the web-app patch overrides base rows, so every profile inherits it. Unbound seats stay unmounted, so the row is a no-op until the user binds a seat in Settings; a bound seat appears as its own model-facing tool with its configured provider/model, alongside the generic `subagent` tool. A per-preset row was tried first and reverted: `agent-seats` registers the `agent-seats` settings namespace, a settings namespace tolerates exactly one live registration (`SettingsProvider.register` fails loud on duplicates), and a preset row applies once per composed scope — a concurrent session, or every in-process subagent child joining its parent's preset — with the duplicate landing on Cordis's async injection fiber rather than the plugin load, making the failure racy instead of clean. `agent-seats.spec.ts` pins the constraint with a direct duplicate-registration probe.

**Child session ids keep their bare-UUID form.** A `session-` prefix was tried and reverted: notice summaries are clamped to `CONTEXT_SUMMARY_MAX_CHARS` (120) by `boundContextSummary`, and the 8-character prefix pushed the standard settlement summary from 119 to 127 characters, ellipsizing "…unless you send it more." off every settlement notice. The readability win did not justify changing a shared bound or the summary wording.

## Alternatives considered

**Read the route from the child's session at result time.** Rejected: a continuable start returns before the child's first request exists, so there is nothing to read yet; the route is determinable at request time and that is what the model and the log should see.

**Make `agent-seats` a host-plane row instead of a preset row.** Rejected: model-facing tool surface belongs to the per-session agent composition (the direction every peer tool took), and a host-plane row re-creates the divergence that caused the gap.

**Raise `CONTEXT_SUMMARY_MAX_CHARS` to keep the id prefix.** Rejected: the bound is shared with job notices and is a deliberate transcript-row budget; widening it for a cosmetic id change inverts the priority.

## Consequences

The parent log now answers "what did the child run" at the spawn seam without log forensics, and the main agent can read the route from its own tool results. Children inherit the model the parent is actually running, which also means an unbound generic delegation now spawns on the parent's (typically larger) model rather than silently downgrading to a stale creation route — bind a seat or an instance `agentOptions` when cheap children are wanted. Seat bindings in Settings now produce real tools in every profile through the base bundle. `list_agents` rows for cold children show no route until the child makes its first request.

## Related

- [J-Space deployment review and uplift roadmap (Claude)](../../proposed/feature/2026-08-18-jspace-deployment-review-and-uplift-claude.md) — the dogfood-session analysis that surfaced these defects.
- [J-Space control loop](2026-08-18-jspace-control-loop.md) — the same session's jspace findings.
