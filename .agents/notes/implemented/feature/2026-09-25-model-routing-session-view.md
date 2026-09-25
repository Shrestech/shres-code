# Agent Note: Per-session Routing view

Status: implemented

## Problem

Model routing logs every decision, but nothing in the GUI said what routing did in a session, why it kept the strong model, what a switch cost in cache, or which judge answered. Several sessions run at once, so session activity cannot live in global Settings: it belongs beside the session's Chat and Trajectory views. The owner-approved design (model routing UI v2.1) places a read-only Routing view in the session's Activity popover, keeps the mode control on the Auto chip, and reports tokens, shares, and latency only, with no price or dollar figure.

## Decision

**Placement.** `ui-model-routing` registers a `conversation.view` entry, id `routing`, order 20, so the Activity popover lists `Routing →` after Chat and Trajectory and selecting it replaces the session body. The view shows the mode read-only; the Auto chip in the chat input stays the one control. The web client composes this plugin whatever the host composes, and the popover lists a global ledger of view entries, so the entry is registered only after the host answers one `modelRouting.gate()` read: only a host that loaded the router claims that endpoint.

**Data.** The host folds each session's log into the `modelRoutingStats` session projection, owned by `model-router` (`src/stats.ts`): decision and step counts, reason and exit histograms, best-candidate confidence and margins, a judge-latency histogram over fixed 1-2-5 buckets, tokens per model by class under the usage presence contract, cold prefills by cause, tokens moved off the strong model, judge asks and state characters per engine, the step timeline, and the 200 most recent decisions. The fold is pure and its state is plain JSON, as the projection contract requires, so the persisted projection cache serves it and the existing push channel delivers it with no polling. No session event is added. Router configuration is not in the log, so two unary Remote reads on the `modelRouting` service complete the view: `gate()` returns the thresholds, deadline, and difficulty scores in force, and `decision(sessionId, seq)` returns one logged decision for the drill-down.

**Charts.** G1 to G6 are hand-built SVG coloured by new `--dsw-alias-chart-*` aliases in `ui-theme`. Each graph has a `<title>`, a text alternative generated from its data, a Table toggle, a visually hidden table as the screen-reader default, and focusable marks. The strong model is always `chart-strong`, pool candidates take the series colours by pool order, and every model also has a marker glyph.

**Handoffs.** `ui-conversation` generalizes the one-shot inspect handoff to `InspectRequest { view, target }`, where the target is a call, an event seq, or none; a persisted legacy `{ callId }` rehydrates as a Trajectory call target. Views receive `reveal(request)` and `canReveal(view)`; `reveal` writes the request, selects the view, and closes the Activity popover, and only the view the request names receives it. Trajectory resolves an event target to the record containing that seq, else the nearest earlier record, and each ROUTING row carries an `Explain` link back to the Routing view's drill-down.

**Fold choices.** The log records no model's prompt-cache lifetime, and a checkpointed pure fold cannot read live model info, so idle expiry uses 300 s and the snapshot reports that fallback. A cold call counts as a routed switch only when a candidate served it; the manual-route retry after `route-failed` counts as a routed return. The timeline keeps the most recent 400 marks and 400 decisions, so the persisted state stays bounded; a log above 400 steps is drawn one point per turn by majority model.

**Pre-8b statistics.** Decisions do not yet record the judge's engine id, token usage, eligibility time, input size, or the latency of a failed ask. The fold therefore labels state characters as an upper bound (`stateProjection.maxChars`) unless the decision recorded the exact state text, and the latency histogram covers answered asks only.

**Opening the view from the chip.** The Auto chip's Routing details item reveals the `routing` view with a `{ kind: 'none' }` target, which selects the view and stores no request. The chip's seat lives in the composer bar, which is `session-maybe` scoped, while the chat store is mounted under the strict `session` scope, and one store handle mounts under one scope. `ui-conversation` therefore records each session's reveal when its session registration mounts the store, and the composer bar hands the seat a reveal that calls the recorded one.

## Alternatives considered

**Stats in the `modelRouting.stats` RPC for session scope.** The v1 contract computed session statistics on request. A pushed projection is incremental, cached across restarts, and reaches every open view without polling; the RPC variant remains for the workspace rollup only.

**Thresholds inside the projection.** A projection's `apply` and `view` are pure functions of the log, and decisions do not record the thresholds that gated them. Reading live configuration there would make a cached value depend on state outside the log, so the gate is a separate unary read labelled as the configuration in force now.

**A per-session availability field on list entries.** A list registration could declare a required projection key, with the Activity popover listing a view only for sessions whose projections carry that key. That adds a field to the slot framework's list options for one caller, while router composition is a host-wide fact the gate read already reports.

**A mode toggle in the view.** Two controls for one mode invite disagreement about which one is authoritative; the view repeats the mode as a status line and names the chip.

**A chart library.** The web styling rules exclude component and chart libraries; the six graphs are small, fixed encodings over data the host already aggregated.

## Consequences

- A session's routing activity is readable where the session is, and two open sessions render independent views from their own projections.
- Charts draw the threshold in force now, and the drill-down labels its comparison "threshold now", because decisions do not record the thresholds that gated them; one derivation resolves a decision's thresholds and their source, so recorded values replace the configured ones there when decisions carry them.
- Judge identity, status, and egress (the status line's judge segment, the remote-egress confirm on the Auto chip, the Sent off-machine split, and Settings links) come from the host judgment-engine registry read, which lands separately; until then the egress tile reports the egress as unknown.

## Verification

- `packages/llm/model-router/tests/stats.spec.ts` folds live-shaped and active fixtures through every statistic definition, the caps, and the same-reference rule; a real Loader composition checks that the projection's counts equal the counts computed from the log.
- `packages/client/ui-model-routing/tests/` covers the derivations, every chart's text alternative, Table view, and keyboard path, the view states, the drill-down's loading, failure, and retry, the handoffs in both directions, two concurrent sessions, and the plugin's registration and teardown.
- `packages/client/ui-conversation` and `packages/client/ui-trajectory` specs cover the `InspectRequest` handoff, the legacy rehydrate, the popover closing on reveal, event-target resolution, and the `Explain` link.
