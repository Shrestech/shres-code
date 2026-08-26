# Agent Note: Addressable agent message bus

Status: proposed

## Problem

Prime Agent's model (paper §2.4 + repo): a daemon mediates family queues. Agents address parent, children, and **siblings** by id. Queued messages survive idle→active transitions and client detach; the daemon mailbox outlives any single client. [MAPPING technique inventory item 12](../../../../MAPPING-prime-agent-2026-08-26.md) records our status as **PARTIAL**.

shres-code today already has most of the hard parts:

| Capability | Status |
|---|---|
| Continuable children with stable durable ids (`childId: SessionId`) | `SubagentRuntime.startContinuable()` |
| Activation manager: running / waiting / settled residency derived from quiescence + owned-child set | [`continuation.ts`](../../../../packages/subagent/subagent/src/continuation.ts) |
| Followup routing by residency: enqueue → wake → cold-resume | `followup()` |
| Durable queue that survives restarts | the Agent inbox is an incremental projection over `agent/inbox/spliced` session-log events ([`inbox.ts`](../../../../packages/core/agent/src/inbox.ts) replays them from `seedLength`); cold resume reads persisted sessions |
| Child→parent report channel + runtime settlement notices | `reportFrom()`, `notifySettlement()`, distinct `MessageSource` kinds (`coordinator`, `subagent-report`, `subagent-settled`) |
| Model tools: `send_message`, `interrupt_agent`, `list_agents` | `tool-subagent-control` (+ `/list-agents` split) |
| **Sibling / arbitrary-agent addressing** | missing: `followup()` requires the exact live **direct parent**; `reportFrom()` derives its sole recipient from the durable header |
| **Accept mail without materializing the receiver** | `followup()` always cold-resumes immediately; no "park in storage, wake later" mode |
| **First-class message envelope** (sender/receiver/correlation as durable data) | envelope is implicit: a `UserMessage.source` on the receiver's log plus the sender's `send_message` tool result |
| **Mailbox read without starting a turn** | missing |

The gap is narrower than "build a bus": it is **authority widening + acceptance decoupled from residency + explicit envelopes**. The per-agent inbox should stay the only queue — the doc's invariant "the Agent inbox is the only queue … one observable order" is correct and Prime-compatible.

## Proposal

Generalize the continuable-child inbox into residency-independent, family-scoped mailboxes so shres-code matches Prime Agent's `rlm()` + `agent_message` communication and beats it on typing, durability, and enforcement. Extend `ctx.subagents` (do not add `ctx.agentmail`). Four phases, independently shippable, default-off where new behavior is gated: family-membership resolver + event declaration; quiet durable mail under the child lock; family addressing + `read_mailbox`; apiproxy/UI surfaces. Sequencing is [WP1.4 → WP2.2 → WP3.2](2026-08-26-beat-prime-agent-roadmap.md).

## Residency-independent mailboxes keyed by branded agent ids

### Identity

Reuse the existing brand. Every session-backed subagent's stable id **is** its `SessionId` (`Branded<'SessionId'>` from `shres-brand`), stable across activations by construction. Do not mint a parallel `AgentId`: two brands for one referent invites mismatch. If a distinct wire name helps tool schemas read better, add `type AgentRef = SessionId` alias at the seam, not a second brand.

### The mailbox stays where it is

Each target session's own log remains its mailbox:

- Pending = `next-turn` inbox slice reconstructed from `agent/inbox/spliced` events.
- Accepted order = append order of those events (one observable order, unchanged).
- Claim/discard = existing splice deletions + `user/message` at claim time.

What changes is who may deliver and when materialization happens.

### Acceptance decoupled from residency

Today `followup()` resolves residency synchronously: enqueue into the live Activation, or cold-resume then submit. Add a second delivery posture, mirroring the report channel's `'quiet' | 'wakeup'` split:

```ts type-equiv
/** Scheduling policy for one accepted bus message. */
type MailDelivery = 'wakeup' | 'quiet'
```

- `'wakeup'` — exactly today's `followup()` path: enqueue / wake / cold-resume.
- `'quiet'` — accept without opening a turn. Live targets use the existing park primitive; cold targets append through persistence. See [Quiet-mode write design](#quiet-mode-write-design).

Quiet acceptance must take the same per-child lock (`locks.run(childId, ...)`) as every other delivery so it cannot interleave with a concurrent materialization or disposal transaction. If persistence is absent, quiet rejects loud with **`PERSISTENCE_UNAVAILABLE`** ([`continuation.ts:1503-1511`](../../../../packages/subagent/subagent/src/continuation.ts)), the same code cold resume uses when the persistence service is missing. Inspect-failure and unsupported continuation state stay **`NOT_RESUMABLE`** ([`continuation.ts:936-942`](../../../../packages/subagent/subagent/src/continuation.ts)). Start-time capability absence stays **`UNSUPPORTED_CAPABILITY`** ([`start-capabilities.ts`](../../../../packages/subagent/subagent/src/start-capabilities.ts)).

### Family scope

Authority scope = the **session family**: all sessions connected to one root through uninterrupted `parentSession` chains (ordinary forks terminate propagation — the same rule `indexSubagentDescendants` uses in the web runtime). Membership is computed from durable headers over the live-preferred corpus `listChildren()`/`listDescendants()` already merge (`ctx.sessions.list()` + optional `ctx.sessionPersistence.list()`). No new state: family membership is derived, cached per listing pass like today's descriptor ladder.

Delivery matrix (phase 1 → phase 2):

| Sender → receiver | Phase 1 | Phase 2 |
|---|---|---|
| Parent → direct child | today | yes |
| Ancestor → deeper descendant | no | yes (interrupt already allows live ancestry; send catches up) |
| Descendant → any live ancestor | report-to-parent only | yes, generalized report |
| Sibling ↔ sibling (shared parent) | no | yes — the Prime-parity case |
| Any pair within one family | no | yes |
| Cross-family | no forever (`UNAUTHORIZED`) | no |

One-shot children stay undeliverable in every direction. **`NOT_CONTINUABLE` is a proposed new error code** for that case; today messaging a one-shot id yields `NOT_RESUMABLE` via `coldResume` ([`continuation.ts:936-942`](../../../../packages/subagent/subagent/src/continuation.ts)). The new code is distinct so callers can tell "this id is a one-shot" from "this continuable child has no supported state." `list_agents` continues to omit one-shots.

### Source attribution

Add one merge-extensible `MessageSourceMap` kind next to the existing three:

```ts type-equiv
/** Durable attribution for a bus message between family members. */
interface AgentMailMessageSource {
  readonly kind: 'agent-mail'
  /** A message another agent addressed to this one. */
  readonly form: 'relay'
  /** Session id of the sending agent. */
  readonly senderSessionId: SessionId
}
```

Settlement notices keep their distinct kind — a transcript must never credit the child with the manager's words (existing rule).

## Durable session events

### New plugin-owned event: `subagent/mail`

Declared by `shres-subagent` via `declare module` merging (same mechanism as `subagent/descriptor`), regenerated into `KNOWN_SESSION_EVENT_TYPES` by `gen-persistence-catalog`.

```ts type-equiv
interface SubagentMailData {
  /** Envelope format version; supporting another field is a deliberate bump. */
  readonly version: 1
  /** Identity of this mail; equals the accepted UserMessage id on wakeup delivery. */
  readonly messageId: MessageId
  /** Sending session. */
  readonly sender: SessionId
  /** Receiving session (redundant with the log it lives in, but makes receipts self-contained). */
  readonly receiver: SessionId
  /** Scheduling policy chosen at send time. */
  readonly delivery: 'wakeup' | 'quiet'
  /**
   * Optional caller-chosen pairing key. Branded because it crosses the
   * durable / tool / RPC boundary; the caller mints it, the harness does
   * not allocate or validate uniqueness.
   */
  readonly correlationId?: MailCorrelationId
}

type MailCorrelationId = Branded<'MailCorrelationId'>
```

`correlationId` is **not** a bare `string`. Callers mint `MailCorrelationId` values the same way they mint `MessageId` (brand constructor, no format check). The harness treats two equal ids as the same pairing key and does not generate them.

Placement rules:

- Appended on the **receiver's** log at acceptance, immediately before its inbox splice — position carries the authoritative queue order, so replay needs no side index.
- Log-only: never `surfaceOp`, never derived history (descriptor precedent).
- **Required-on-read** (no `ignorable` marker): reconstruction of pending work depends on it, and the default-required posture is deliberate — forgetting the marker over-refuses rather than silently gutting the mailbox.
- Compaction-safe: append-only log retains it even when the shadowing summary replaces claimed turns.

Optional companion on the **sender's** log: `'subagent/mail-sent'` receipt (`ignorable: true` — pure audit; the sender's `tool/result` already logs intent under model-visible ⟺ logged). It buys durable correlation lookup for replies and cross-session debugging without touching reconstruction. The RPC-sender path is specified under [Quiet-mode write design](#quiet-mode-write-design).

### Replay / fork behavior

- **Replay:** `Inbox` constructor already replays post-seed splices; envelopes ride along positionally. Quiet mail delivered while the process was down re-materializes as pending work on next activation — this falls out of existing machinery once quiet writes real splices.
- **Fork:** seed is the balanced completed-turn prefix; `Inbox` skips pre-`seedLength` events, and the envelope reader applies the identical gate. Rule stated explicitly in the contract: **mail is history, not pending state** — a forked child inherits the conversation record but not the original's queued mail. Family membership of the fork restarts from the fork point (fork terminates propagation), which the lineage walk gives for free.
- **SESSION_FORMAT_VERSION stays 0.** Additive known types are not structural format changes; the jspace/schedule/tracker events set the precedent. Only a change to how existing events are interpreted would bump.

### Model-visible implications

The invariant holds with zero new surface machinery: a queued message enters a prompt exactly when the loop claims it, appending an ordinary `user/message` whose `source.kind` distinguishes provenance (`agent-mail`, or the legacy kinds during migration). Envelope events themselves never reach model history. One consequence worth documenting: **quiet mail can age**. A message parked for days enters a prompt far from its original context, so the claim-time framing should carry the sender id and relative recency ("from sibling X, queued N messages ago"), matching the settlement-notice pattern of runtime-framed relay content. For injection hygiene, route sibling-originated text through `frameUntrusted` at claim framing time — precedent exists in `session-reference`.

## Quiet-mode write design

This subsection decides the write path that [Acceptance decoupled from residency](#acceptance-decoupled-from-residency) names. Phase 1 implements (c) only; later bullets are written so phase 2 does not invent a second writer.

**(a) Event construction.** Splices today are minted only inside `Inbox.mutate` via `Session.append` ([`inbox.ts:158-187`](../../../../packages/core/agent/src/inbox.ts)). Quiet delivery to a **cold** target has no Session, so it cannot call `Inbox.mutate`. Under `locks.run(childId)`:

1. `inspect` the receiver log; the next seq is `events.at(-1)?.seq + 1` (or `0` on an empty log).
2. Mint the `UserMessage` with `createUserMessage(...)` so `MessageId` allocation matches the live path ([`packages/llm/llm/src/message.ts`](../../../../packages/llm/llm/src/message.ts)).
3. Build two `SessionEvent` values with consecutive seqs: `subagent/mail` (envelope) then `agent/inbox/spliced` (insert the message into `next-turn`). Envelope-then-splice is the required order; position is the queue.
4. `ctx.sessionPersistence.append(childId, [envelope, splice])` as one batch ([`session-persistence/src/index.ts:144`](../../../../packages/session/session-persistence/src/index.ts)). A torn write of the first event alone is a persistence-backend failure; the batch is the unit.

**(b) Live-target rule.** Quiet delivery to a **live** Activation is accepted, not rejected. Use the existing park primitive `Agent.send(message, target, wakeup=false)` ([`runtime-types.ts:112-121`](../../../../packages/core/agent/src/runtime-types.ts)). That path still holds the child lock, still appends the envelope on the receiver's Session immediately before the splice (Session.append, not persistence.append), and does not open a turn. Rejecting live quiet would force senders to branch on residency and would make `mode: 'quiet'` mean "fail if the child happens to be running."

**(c) Phase-1 scope.** Parent-to-direct-child only, the same relation `followup()` authorizes today. Ancestor, sibling, and general-family pairs wait for phase 2. The quiet writer is therefore a delivery-mode addition on the existing parent→child path, not a new authority matrix.

**(d) `maxSentPendingPerTarget` bookkeeping.** Count, under the same lock, unclaimed `subagent/mail` envelopes on the **target** log whose `sender` equals the caller and whose matching splice has not been claimed (the message id is still in the pending `next-turn` projection). That count is the sender-in-flight figure; exceeding `maxSentPendingPerTarget` rejects `MAILBOX_FULL` with the cap and the count. No side index: the fold is the same envelope pass `mailbox()` already performs. The receiver-wide `maxPendingMail` cap is the same fold's total pending count.

**(e) `read_mailbox` framing.** A pure function of one pending envelope: sender session id, queue position (0-based in current pending order), relative recency ("queued N messages ago"), and a bounded preview of the untrusted body run through `frameUntrusted`. It is the same function claim-time framing uses; the tool applies it without claiming. Presentation methods remain functions of args (generic render intent).

**(f) RPC-sender path for `subagent/mail-sent` receipts.** After the receiver batch commits, append one ignorable `subagent/mail-sent` on the **sender** log: live sender → `Session.append`; cold sender → `sessionPersistence.append` with inspect-then-next-seq, under the sender's lock if the sender is also a continuable child, otherwise under a sender-id lock keyed the same way. Failure to write the receipt does not roll back delivery (the tool result already records intent); it logs a warning. The RPC `subagent.prompt` / future `subagent.send` path uses this same receipt writer so tool and RPC stay aligned.

**(g) Plugin registration.** `read_mailbox` is a separately loadable plugin. Raw/Web `cordis.yml` bare plugins must appear in their resolver manifest's `dependencies` (`verify-cordis-config`). The new plugin package is added to that manifest in the same PR that introduces the plugin.

**(h) Sibling detection.** `listDescendants` walks down from a root; it does not answer "do A and B share a parent." Phase-2 sibling (and general-family) authorization computes the lowest common ancestor by walking `parentSession` chains from both ids over the merged corpus until they meet or either chain ends. Siblings: LCA is the parent of both and is not either endpoint. Ancestor/descendant: one id **is** the LCA. Unrelated or cross-family: no LCA inside the caller's family root → `UNAUTHORIZED`. Ordinary forks terminate the walk (same rule as descendant indexing).

## Authority and abuse bounds

### Extending the direct-parent check

Today three checks exist: `followup` (exact live direct-parent object), `reportFrom` (exact live child; recipient derived), `interrupt` (human parent address **or** exact live ancestor in the recorded lineage). The interrupt pair is the template for widening: keep **exact live Agent identity** as the credential (`ctx.agents.get(caller.id) !== caller` staleness check), replace the *relationship* predicate.

New resolver, shared by all bus operations:

```
resolveFamilyMembership(caller: Agent, target: SessionId):
  | { ok: true; relation: 'ancestor'|'descendant'|'sibling' }
  | { ok: false; code: 'UNAUTHORIZED' }
```

Implementation walks the merged corpus headers both directions from the target (bounded by tree size; reuse the `listDescendants` traversal **plus** the LCA step in (h)). Stale callers reject before lookup, exactly as interrupt does. `MessageSource` continues to grant no authority. The human/root client keeps a fourth tier via the apiproxy path (`subagent.prompt` today), which acts as root-of-family.

### Abuse bounds

All config-validated fields on the subagent service `Config` (no hardcoded tunables; `maxConcurrentSubagents` is the template):

| Control | Mechanism | Default proposal |
|---|---|---|
| Receiver backlog cap | `maxPendingMail: number \| 'unlimited'` — acceptance beyond cap rejects `MAILBOX_FULL` (loud, never silent drop) | 32 |
| Sender-in-flight cap | `maxSentPendingPerTarget` — one sender cannot fill one mailbox alone | 16 |
| Turn budget coupling | every mail-driven turn consumes the receiver's `maxStepsPerTurn` budget ([`packages/guard/step-budget`](../../../../packages/guard/step-budget/src/index.ts), commit `3b2bc1b157`) | inherited |
| Loop prevention (spawn recursion) | existing monotone `delegationDepth` floor + absolute `maxDepth` | unchanged |
| Loop prevention (message ping-pong) | no auto-relay: a delivered message never implicitly sends another message; the only implicit sends remain settlement notices (one per epoch, already capped). If auto-triage relays ever arrive, add a hop-count/TTL envelope field decremented per relay | n/a today |
| Interrupt authority | deliberately NOT widened to siblings — stop rights stay with the human address or live ancestry | unchanged |

Ping-pong analysis: A→B costs B one turn; B→A costs A one turn. Without auto-relay each hop requires a model decision to spend its own step budget, and repeat-tool veto plus `maxStepsPerTurn` bound runaway loops per agent. Caps make even coordinated spam fail loud instead of queueing unboundedly.

## Consumer tool surface and console

### Tools

- **`send_message`** (extend, don't break): parameters gain optional `mode: 'wakeup'|'quiet'` (default `wakeup`) and optional `correlation_id` (branded `MailCorrelationId` on the wire as a string that the adapter brands). Description updated: works for any member of your session family you can name, not only your direct children. Output adds `status: 'accepted' | 'queued-storage'` so the model distinguishes a live enqueue from a parked one. Error text keeps the existing "failure means NOT delivered" contract.
- **`list_agents`** (enrich): each entry gains `pendingMail: number` (envelope count folded in the same corpus pass — cheap because listing already inspects persisted rows) and, for depth>0 entries, wording changes from "you may use `send_message` only for depth-1" to family-scope phrasing. Keep `interrupt_agent`-only note for stop rights.
- **`read_mailbox`** (new, separately loadable plugin alongside `/list-agents` so deployments can expose discovery without polling): returns the calling agent's own pending mail — messageId, sender, framed preview, queue position — **without waking anything**. Claiming still happens only through ordinary turn consumption; the tool is strictly read-only. This closes the "poll for completion" anti-pattern safely: the model sees what is waiting but cannot spin turns just to check.
- **`interrupt_agent`**: unchanged.

### Agents View / web console

- `ui-subagent` catalog rows already render mode/activity/tokens/duration; add a pending-mail badge fed by one integer per row. Cheapest wire: extend the apiproxy's subagent catalog RPC row with `pendingMail` computed server-side from the same projection pass `listChildren()` runs — the browser never reads logs directly (package constraint: ui-subagent never receives host context). The [Agents View](2026-08-26-beat-prime-agent-autonomy-accounting.md) forest consumes the same integer ([roadmap WP2.2 → WP3.1](2026-08-26-beat-prime-agent-roadmap.md)).
- Conversation composer: unaffected for wakeup mail (joins FIFO like today). For quiet-parked children, the existing read-only composer logic ("exact parent unavailable") should distinguish *parked-with-mail* (show badge + drain button that issues one wakeup send) from plain unavailable.
- Family addressing changes the **request** schemas in [`packages/host/apiproxy/src/api/subagents.schema.ts`](../../../../packages/host/apiproxy/src/api/subagents.schema.ts), mapped at [`packages/host/apiproxy/src/fetch/handler.ts:105`](../../../../packages/host/apiproxy/src/fetch/handler.ts) (`subagent.prompt` today; a `subagent.send` row if one is added). Response **value** schemas are mapped at [`client.ts:185-188`](../../../../packages/host/apiproxy/src/fetch/client.ts). `subagent.interrupt` stays restricted.

There is no `packages/api/subagents.schema.ts`; the zod schemas live in the apiproxy package as cited above.

### Snapshot obligations (testing policy)

A non-trivial model-visible change ⇒ keyless snapshot through a real example in the same PR: a headless fixture where a parent sends a sibling message and the transcript shows the framed relay row. Fixtures must replay on macOS/Linux. Sibling send is a phase-2 snapshot; phase 1 snapshots a parent→child quiet send that appears as pending without a child turn.

## Shape decision and phases

Recommended: **additive methods on the existing service**, provider-neutral by construction.

- The continuation manager already owns per-child locks, activation admission, authorization, descriptors, and the corpus merge. A parallel bus service would duplicate family resolution, race `locks.run(childId)` against deliveries, and split authority checks across two seams.
- Provider neutrality comes free: providers participate only in `prepareContinuable`; the manager owns everything after. Remote providers (acp/codex/claude-code) have no local session, hence no mailbox — family sends to them reject `UNSUPPORTED_CAPABILITY` at start-time (they cannot be continuable mailboxes) and `PERSISTENCE_UNAVAILABLE` / `NOT_RESUMABLE` on the cold path as documented capability absence, identical to cold-resume today.
- Nothing existing changes signature: `followup()`, `reportFrom()`, `startContinuable()` keep behavior; parent→direct-child keeps working (migration invariant #1). New API: `send(spec)` (family-addressed, both modes) and `mailbox(sessionId)` (read-only enumeration). Old `send_message` maps onto `followup()` until phase 2 switches its adapter to `send()` with relation=direct-child fast-path.

| Phase | Content | Estimate |
|---|---|---|
| 0 — groundwork | Extract family-membership resolver from the `listDescendants` corpus walk; declare `subagent/mail` (+ regen catalogs); unit tests for envelope replay/fork gates | 1–2 d |
| 1 — quiet acceptance | Storage-only delivery under the child lock; live park via `Agent.send(..., wakeup=false)`; `maxPendingMail` / `maxSentPendingPerTarget` caps; `MAILBOX_FULL`; config validation; focused tests | 3–4 d |
| 2 — family addressing | `send()` with ancestor/sibling/general pairs (LCA step); stale-caller checks; `send_message`/`list_agents` updates; `read_mailbox` plugin; snapshots | 4–5 d |
| 3 — surfaces | apiproxy RPC schema extensions; ui-subagent mail badge + parked-drain affordance; docs (`subagent.md`, READMEs), Agent Note(s), doc-sync gates | 3–4 d |

**Total ≈ 2.5–3 weeks** single-developer, each phase independently shippable. Phase 1+2 are the Prime parity core; phase 3 can lag.

Why this beats Prime, not just matches it:

- **Typed, required-on-read envelopes** vs untyped JSONL queues: replay refuses wrong-vocabulary logs instead of skipping silently.
- **Executor-enforced caps** (`MAILBOX_FULL`, step-budget coupling) vs Prime's observed-not-stated limits (Factorio max-7-concurrent was emergent).
- **Derived family scope from durable headers** vs daemon-held membership: no supervisor process to outlive, no split-brain between daemon state and session truth.
- **Compaction-aware retention**: envelopes survive summarization by design; Prime's queues are outside its compaction story.
- **Read-without-wake** (`read_mailbox`) avoids the poll-for-completion pattern `list_agents` already warns against, while giving models visibility Prime reserves for the host.

## Alternatives considered

**Add `ctx.agentmail` as a parallel service.** Rejected: the continuation manager already owns per-child locks, activation admission, authorization, descriptors, and the corpus merge. A parallel bus would duplicate family resolution, race `locks.run(childId)` against deliveries, and split authority checks across two seams.

**Reject quiet delivery to a live Activation.** Rejected: `Agent.send(message, target, wakeup=false)` already parks without waking ([`runtime-types.ts:112-121`](../../../../packages/core/agent/src/runtime-types.ts)). Forcing senders to inspect residency would make `mode: 'quiet'` fail whenever the child is running.

**Mint a parallel `AgentId` brand.** Rejected: the stable id already is `SessionId`; two brands for one referent invites mismatch.

**Widen interrupt authority to siblings.** Rejected: stop rights stay with the human address or live ancestry.

**Auto-relay of delivered mail.** Rejected: each hop must be a model decision that spends the receiver's step budget.

**Leave `correlationId` as `string`.** Rejected: it is a cross-boundary durable id (AGENTS.md branded-ids rule). Branded as `MailCorrelationId`; the caller mints it.

## Acceptance criteria

- Phase 0: family-membership resolver is a unit-tested function with the same answers as today's parent/descendant checks; `subagent/mail` is in `KNOWN_SESSION_EVENT_TYPES`; `pnpm run doc-sync` catalog regen is green.
- Phase 1: a parent can quiet-send to a direct child that is not live; the child's log contains envelope-then-splice; no Activation is created; a later wakeup or UI prompt drains it. A live child quiet-send uses `Agent.send(..., wakeup=false)` and does not open a turn. Absent persistence rejects `PERSISTENCE_UNAVAILABLE`. Over-cap rejects `MAILBOX_FULL`. One-shot ids reject `NOT_CONTINUABLE` (new code).
- Phase 2: sibling send in one family succeeds; cross-family send rejects `UNAUTHORIZED`; LCA unit tests cover fork-terminated chains. `read_mailbox` returns pending rows without a turn; its plugin is in the resolver manifest.
- Phase 3: `subagent.prompt` request schema in [`subagents.schema.ts`](../../../../packages/host/apiproxy/src/api/subagents.schema.ts) accepts family targets; ui-subagent shows a pending-mail badge; `docs/subsystems/subagent.md` describes the bus.
- Keyless snapshot through a real example in the same PR as the model-visible framing change. Product-user-visible GUI (badge, parked-drain) carries a GIF from the real server/model flow.
- `pnpm run test:coverage`, `pnpm run duplication`, `pnpm run doc-sync` pass. Capability ships default-off; a pre-registered paired bench arm exists before any default flip.

## Risks

1. **Lock discipline.** Quiet delivery racing a disposal transaction is exactly the send-vs-dispose cutoff `followup()` handles with v8-ignored retry arms; quiet mode must reuse the same loop, or mail lands in a closing handle. Mitigation: implement quiet *inside* the existing `locks.run` critical section, not beside it.
2. **Injection spread.** Sibling mail crosses subtree isolation that fork seeding implied. Mitigation: `frameUntrusted` at claim framing, relay-form source marking, and keeping mail delivery out of any trusted instruction channel.
3. **Authority confusion.** Widening send could be misread as widening permission. Mitigation: docs state mail grants no execution authority; the receiving turn still passes the receiver's own approval/policy plugins.
4. **Log growth.** Parked mail accumulates in receiver logs. Existing windowed RAM + SQLite tombstones bound memory; retention policy can prune *claimed* envelopes later (they're reconstructible from user/message history) — defer.
5. **Catalog/codegen gates.** New event type requires `gen-persistence-catalog` + `verify-*`, cordis-surface regeneration, and `KNOWN_SESSION_EVENT_TYPES` freshness in doc-sync; forgetting one fails CI loudly (good).
6. **Urgency calibration.** [MAPPING technique inventory item 12](../../../../MAPPING-prime-agent-2026-08-26.md) records PRO-LONG beating 4-role orchestras with **zero subagents**. Phases are ordered so the cheap, defensible pieces (durable quiet mail + caps) land first; sibling addressing — the genuinely novel orchestration surface — lands last and behind config.
7. **Cold-path seq races.** `sessionPersistence.append` takes caller-assigned seqs. Mitigation: inspect + append stay inside `locks.run(childId)` so a concurrent materialization cannot publish a conflicting seq; live deliveries go through Session.append instead.

## Appendix: exact touch points

| File/package | Change |
|---|---|
| [`packages/subagent/subagent/src/continuation.ts`](../../../../packages/subagent/subagent/src/continuation.ts) | `send()`, `mailbox()`, quiet acceptance inside `locks.run`, family resolver wiring, `NOT_CONTINUABLE` |
| [`packages/subagent/subagent/src/index.ts`](../../../../packages/subagent/subagent/src/index.ts) | Config fields (`maxPendingMail`, `maxSentPendingPerTarget`), new service methods + generated catalog |
| new `.../src/mail.ts` | `SubagentMailData`, `MailCorrelationId`, fold/gate helpers (mirror `descriptor.ts`) |
| `scripts/gen-persistence-catalog` output | `subagent/mail` in `KNOWN_SESSION_EVENT_TYPES` |
| [`packages/subagent/tool-subagent-control/src/index.ts`](../../../../packages/subagent/tool-subagent-control/src/index.ts) | `send_message` params/output |
| `.../list-agents.ts` | `pendingMail`, family wording |
| new `/read-mailbox` plugin + resolver-manifest `dependencies` | optional read-only tool |
| [`packages/host/apiproxy/src/api/subagents.schema.ts`](../../../../packages/host/apiproxy/src/api/subagents.schema.ts) | request schemas for family addressing |
| [`packages/host/apiproxy/src/fetch/handler.ts`](../../../../packages/host/apiproxy/src/fetch/handler.ts) / [`client.ts`](../../../../packages/host/apiproxy/src/fetch/client.ts) | request map vs response value schemas |
| `packages/client/ui-subagent` | mail badge, parked-drain composer state |
| [`docs/subsystems/subagent.md`](../../../../docs/subsystems/subagent.md) | full section rewrite for the bus |
