# Agent Note: Team roster shows each member's own model route

Status: implemented

## Problem

The Team roster reported models that members do not run. `TeamRoster.list()` filled a teammate's `model` from the live child's creation options and otherwise from the Lead's creation options, so an unloaded teammate created on its own model was listed on the Lead's model. The Lead row read only its creation options and missed a model the Lead actually runs through its logged request header or the live default-model selection. `TeamMemberView.provider` held the subagent spawn transport (`spawn`) for started rows and the template's LLM provider for `unstarted` rows, so the Team panel could not show an LLM binding without mixing the two meanings. The `team/member` snapshot recorded no route, so nothing on the Lead log said which model an unloaded teammate resumes on.

## Decision

Three route sources stay separate.

- **Configured template.** `TeamRosterTemplateEntry.provider` / `model` apply only to an `unstarted` name. The roster reads the current template when it lists or starts that name; a started teammate never adopts a later template change.
- **Creation route.** `SubagentRuntime.startContinuable()` returns `ContinuableStart.route`, the `{ provider?, model? }` it writes to the child's descriptor as `agentProvider` / `agentModel` and that cold resume applies as the child's options. It resolves the child's options once, before its first await, and the descriptor, the returned route, and the created child all use that value, so a parent model switch during provider preparation cannot make the first request run a different model than the one recorded. `TeamRoster.spawn()` copies that route onto the `active` `team/member` snapshot as optional `agentProvider` / `agentModel`. Recovery of a leftover provisioning row copies them from the child's descriptor. Only the `active` edge may carry them; the fold, the `./invariant` companion, and the `agentTeam` projection schema reject empty or non-string values and any route on a `provisioning` or `failed` edge. Logs written before these fields existed omit them and replay unchanged.
- **Loaded route.** `effectiveAgentRoute(agent)` in `subagent/src/child-agent.ts` is the parent-route read that spawn inheritance uses: latest logged request header, else the live `agentDefaultModel` selection, else creation options. Spawn inheritance through `effectiveChildRoute` and the Lead roster row both read it. A loaded teammate row reads its latest logged request header, else its creation options, and never the deployment default, because a teammate runs its descriptor route until it makes a request.

An unloaded teammate row reports its snapshot route; a row without one omits the model and never shows the Lead's. `TeamMemberView` carries the LLM provider as `agentProvider` beside `model`; `provider` stays the spawn provider on every teammate row, including `unstarted` rows, which report `spawn`. `agentTeams.view` carries `agentProvider` through the wire row, and the Team panel renders `provider · model`.

Existing-child rebinding and resume semantics are unchanged: the descriptor remains the resume authority and nothing rewrites a started teammate's route.

## Alternatives considered

**Add a read-only `/model` accessor to `agentDefaultModel`.** A picked selection that has not reached a request would show immediately. Rejected: the only consumer would be the roster, and a public service method with one caller is the smell the package rules name. A `/model` switch appears after the switched Agent's next request, the same approximation every log-derived observer uses.

**Reorder `effectiveAgentRoute` to header, then options, then default.** One order for spawn and display would be simpler. Rejected: it changes which model new children receive whenever the parent has no logged header, which is outside a display fix, and the Lead runs the default-model selection before its creation options when that service installs one.

**Read the child Session log for an unloaded row.** The descriptor already has the route. Rejected: a roster read would load one Session per teammate. The Lead-log snapshot answers from the fold the roster already reads.

## Consequences

Old Lead logs list their started teammates without a model until the teammate is loaded again; after that the loaded route applies. Unknown routes are shown as absent rather than guessed.

Coverage:

- `packages/team/agent-team/tests/member-route.spec.ts` runs a Lead on `lead-model` and a teammate on `child-model` through the real subagent stack. It checks the child's actual mock request model, its descriptor, the `active` snapshot, the loaded and then unloaded rows, and a restarted process. It also covers a loaded teammate before its first request, a legacy snapshot without a route, template updates reaching only `unstarted` names, and a Lead row following its logged request header after an in-process model selection.
- `fold.spec.ts` and `invariant.spec.ts` cover valid and invalid durable route fields.
- `continuation.spec.ts` checks that `ContinuableStart.route` equals the descriptor and the child's first request when the parent switches during provider preparation, and that it survives a later parent switch while a later child inherits the switched route; `child-agent.spec.ts` pins `effectiveAgentRoute` precedence.
- `api-proxy-agent-teams.spec.ts` pins the wire mapping; `team-action.client.spec.tsx` pins the panel text.
- `apps/web/tests/team-roster-models.e2e.ts` is the keyless browser acceptance through the shipped Web composition.

## Related

- [Subagent model telemetry and effective-route inheritance](../feature/2026-08-18-subagent-model-telemetry.md) owns spawn-time route inheritance and the descriptor route; this note reuses that function unchanged.
- [Agent Teams runtime with seats as the default roster](../feature/2026-09-11-agent-teams-runtime-and-seats.md) owns provisioning and the Team panel.
- [`team_list` uses `unstarted` for reserved seats](2026-09-16-team-list-unstarted-status.md) owns roster status vocabulary.
