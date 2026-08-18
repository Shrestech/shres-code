# Agent Note: J-Space as a Settings-toggled harness card

Status: implemented

## Problem

A third-party skill named J-Space asks the model to keep a working ledger, classify work into `fast` / `full` / `loop`, and verify before shipping. That protocol lives in `SKILL.md`. It disappears when the user does not invoke `/j-space`, when compaction drops the middle of the session, or when the model stops obeying the ritual. This harness has not measured that skill's completion or token cost; the W0 measurement arm is the instrument that settles it.

This harness already keeps durable task state, but the model is not forced to see it. [`ctx.goals`](../../../../packages/goal/goal/README.md) persists one objective and [does not inject it into the prompt](../architecture/2026-07-31-goal-owned-durable-events.md). [`todo_write`](../../../../packages/todo/tool-todo/README.md) is a standing plan that [clears on the next `turn/start`](2026-07-28-todo-plan-clears-on-next-turn.md). Plan mode is soft guidance. None of these remount when a user flips a Settings switch the way [Shres Shield](../../../../packages/guard/shield/README.md) remounts its engine.

The product gap is not “load their skill.” It is a user-owned allow switch whose on-state keeps a compact, logged working card in every later model request, and whose off-state removes the tools and the section.

## Decision

Settings → **J-Space** is the console. An on/off switch writes the `jspace` settings namespace and the host seat remounts or disposes the consumers. The switch does not concatenate third-party markdown. It mounts or unmounts harness machinery.

Product strings, package ids, `ctx` keys, events, tools, and Settings copy use **J-Space** (`jspace` / `ui-jspace` / `ui-settings-jspace`, command `/j-space`, projection `jspace`, events `jspace/card` and `jspace/closed`). The seat does not vendor Tiger380's `SKILL.md`, sixty-second awakening, first-person workspace ritual, or nine modules, and it does not claim Anthropic's Jacobian J-space. Protocol and card design is derived from Tiger3807861189 J-Space Cognition Suite V3.6 (Apache-2.0, DOI 10.5281/zenodo.21971181).

### What the switch remounts

`enabled: false` disposes tools, the prompt section, the command, and the live dock bindings. The seat stays loaded and `ctx.jspace.status.active` is false, matching Shield’s disabled seat.

`enabled: true` applies, in one remount:

1. `ctx.jspace` service verbs and the session-event writer.
2. Model tools `jspace_open`, `jspace_note`, `jspace_checkpoint`, `jspace_ship`.
3. A `systemPrompt.section` named `jspace:card` whose text is the folded card, or the one-line availability notice when no card is open.
4. A classify-and-rebuild path on assemble so the card cannot be lost the way a skill is. `always-open` and a `loop` pass open a stock card during assemble.
5. `/j-space on|off` for the current session chip (off closes the card; it does not write Settings `enabled`).

Remount follows the Shield `sync()` chain: dispose the previous fiber, read the current settings document, apply or stay inactive. `installSettingsSection` owns the namespace. Unknown config keys fail at load.

### Settings and session controls

Settings namespace `jspace` (user scope, `settings.yaml`):

| Field | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `false` | Master allow. Off unloads every consumer. |
| `mode` | `'available' \| 'always-open'` | `'available'` | `available` mounts tools and waits for `jspace_open` or the chip. `always-open` opens a stock card on the first assemble of a session that has none. |
| `requireCoverage` | boolean | `true` | `jspace_checkpoint` refuses a `by` string that matches no coverage term. |
| `coverageTerms` | string[] | `[]` | Extra literal terms merged with the built-in English list. |

Default `enabled: false` because this is an allow switch, not a security screen. Shield defaults on because screening must run; a working card must not tax every chat until the user opts in.

The composer chip is session-local, like [plan mode](../../../../packages/plan/plan-mode/README.md). It opens or closes the card for this session. It cannot turn Settings `enabled` on. When Settings is off, the chip is hidden and `/j-space` is unregistered.

### Logged card

One card per agent session. The session log is the only durable authority. Writers pass `{ ignorable: true }` so older readers resume. `SESSION_FORMAT_VERSION` stays `0`.

```
Goal:      one sentence. What done means. When `ctx.goals` has a current non-complete goal, this line is that objective; the J-Space service does not grow a second goal store.
Core:      at most two live items. A third item requires an explicit swap that writes the departing line first.
Checked:   numbered, append-only. Each line names the verifier and what it covered. Named `Checked`, not `Verified`: the tool cannot prove the verifier ran, and the model trusts its own card — the line must not assert more than the mechanism guarantees.
Open:      unsettled questions, each with what would settle it.
Next:      the single next action. Never empty while the card is open.
```

Event: `jspace/card` with a whole-card snapshot, a monotonic native `seq`, and the writing session id (the fold takes the highest native `seq`; a regressing or foreign `seq` keeps the last good native snapshot and records `fault`), plus `jspace/closed` as a tombstone. A SessionEventMap merge lives on the Service Definition package. The invariant companion rejects a checkpoint with empty coverage when `requireCoverage` was true at write time, a `Core` longer than two items, an empty `Next` on an open card, and a reused Checked number. `goalOpenedSeq` is the session's current `seq` at write time (the first event on a fresh session is `0`).

**Forked agents copy the card; they never share it.** `session/created` and an enable remount (`sessions.list()`) snapshot an inherited parent card into the child session as a native copy (`seq` 1, child `sessionId`). Two fibers writing one shared card under last-write-wins is silent clobbering of `Goal`. Copy-on-fork keeps per-session ownership and makes every card single-writer. Composer chip and dock refuse a projection whose `sessionId` is not the live session.

**Framing integrity on rebuild.** The card labels (`Goal:` / `Core:` / `Checked:` / `Open:` / `Next:`) are harness-authored framing, not content. On fold/rebuild, a card whose lines do not match the schema is corruption: rebuild keeps the last good snapshot, records `fault`, and never renders malformed lines into the prompt. A poisoned card does not only carry a payload — it rewrites what the model believes the task is, in the harness's voice. That class is caught by schema, not by content screening.

Model-visible text is reconstructed from these events. A new model-visible input requires one of these events, per the [session-log rule](../architecture/2026-08-10-session-log-version-mechanism.md).

### Shield and threat interplay

The card is a persistence surface for the attack classes the `test_break` rig demonstrated (memorygraft, legitimacy accumulation):

- **Card writes are content-channel data.** The four tools register through `ctx.tools`, so their args are screened as `tool_args` at `tools/pre-execute` by Shield when it is active. An injection that wants to persist must survive that screen at write time.
- **The re-delivery path is not re-screened.** The `jspace:card` section enters the system prompt, which Shield's `agent/pre-step` does not screen (it screens the claimed message batch). This is accepted and bounded: writes were screened at entry, the rebuild is schema-checked, and the section is voice-marked.
- **Voice registration.** `jspace:card` still needs to join Shield's authority-spoof set in the shield repo. Forged card-shaped lines arriving in tool results must not impersonate the card. That landing is deferred; write-time screening and schema rebuild ship without it.
- **Doctrine inversion, stated once.** Shield's doctrine teaches the model that tool results are data; this feature promotes tool-call output into system-prompt authority. The inversion is bounded by write-time screening and voice marking.
- **What the card multiplies.** A poisoned card does not raise the attack ceiling (TEXT-only, grants no capability). It multiplies persistence × authority: one bend, then the system prompt re-asserts the poisoned goal as established fact on every turn, compaction-proof.

### Prompt section and pass gate

`jspace:card` is prefix-stable for a given card snapshot. Updating Goal, Core, Checked, Open, or Next changes the section and invalidates the KV prefix from that order onward.

When `enabled` and no card is open, the section is one fixed line: the tools exist; open a card for multi-stage or multi-file work.

`classifyJspacePass` is a pure function of the last human text, whether a native card is open, and Settings `mode`. `cardOpen` or `always-open` is `loop`. Otherwise long or persist-shaped text is `loop`, bounded multi-step text is `full`, else `fast`. Classification is reconstructable from the log; it does not write an extra event.

The loop passes claimed user messages into `assembleContextFor(agent, signal, messages)` so the prompt Consumer can classify (and `always-open` / `loop` can open a stock card) during assemble, before `user/message` is appended. Diagnostic `assemble()` calls omit `messages`. This is the one `agent-loop` change; new J-Space behavior otherwise stays on `systemPrompt.section`, `ctx.tools`, `ctx.commands`, and session append.

Do not load third-party J-Space modules, science references, or Dense Track notation into the prompt.

### Tools

| Tool | Args | Failure |
|---|---|---|
| `jspace_open` | `goal`, `next`, optional `core[]` (≤2) | Rejects if a card is already open; rejects `core.length > 2`. |
| `jspace_note` | optional `goal`, `core` swap pair, `open`, `next` | Rejects with no open card; a core swap without a departing line fails. |
| `jspace_checkpoint` | `check`, `by`, optional `evidence: <callId>` | Rejects with no open card; when `requireCoverage` is true, rejects `by` that matches no coverage term (English word-bounded terms first; extra terms via `coverageTerms`; CJK extras are substring includes). `evidence` must name a `tool/call` id that exists in the session log. It raises the cost of fabrication; it does not prove coverage. |
| `jspace_ship` | `path?` | Rejects if Goal is empty, Next is empty, or no `jspace_checkpoint` exists for the current Goal line. Does not close the card. |

Render intent is `generic`. Presentation methods are pure functions of `args`. Native result copy is a compact acknowledgement; the dock and Trajectory read the session events, not the tool result body.

`jspace_ship` is a register check, not a file writer. File delivery stays on existing fs tools.

### UI

Settings page (`packages/client/ui-settings-jspace`), `settings.section` id `jspace`, order 13 (after Shield at 12). Lead with the enable switch. Edit `mode` and `requireCoverage` immediately. Below the switch: this-session path, whether a card is open, checkpoint count. Counts come from the `jspace` projection folded from the log, not from `settings.yaml`. The Host API proxy allowlists `jspace` next to `shres-shield` so the page can read and persist the namespace.

Composer chip (`packages/client/ui-jspace`): visible only when Settings `enabled` is true. On opens the card; off writes `jspace/closed`.

Dock strip in `conversation.input.dock`. Shows Goal and Next while a native card is open; hidden when closed, when Settings is off, or when the projection `sessionId` is not the live session.

Trajectory: fold `jspace/card` and `jspace/closed` onto existing rows as badges (open / checkpoint / closed), the way [`shield/decision`](../../../../packages/client/ui-trajectory/src/client/trajectory-shield-definition.ts) attaches without changing lane labels.

### Package topology

New group `packages/jspace/` (the existing [`workspace/`](../../../../packages/workspace/README.md) group is the directory entity; do not reuse that name).

| Package | Role |
|---|---|
| `jspace/jspace` | Service Definition + in-process store. `ctx.jspace`. Settings namespace, remount, session events. |
| `jspace/jspace-prompt` | Consumer. `systemPrompt.section` + classify/open during assemble. |
| `jspace/tool-jspace` | Consumer. Four tools. |
| `jspace/command-jspace` | Consumer. `/j-space on\|off`. |
| `client/ui-settings-jspace` | Settings section. Never imports the Host package at runtime. |
| `client/ui-jspace` | Chip, dock strip. Trajectory fold lives on `ui-trajectory`. |

`shres-base` mounts the four host packages. `shres-web-app` mounts the two UI packages. Headless mounts host packages only.

## Alternatives considered

**Install their `j-space/` directory as a skill.** Rejected because a skill is lost on non-invocation, compaction, and non-compliance. The user asked for a Shield-style allow switch so the capability cannot vanish that way.

**Settings toggle that injects `SKILL.md` as a system-prompt section.** Rejected because that is a skill with a button. Compaction still drops the middle; the token tax stays; the model can still skip the ritual. The switch would report on while the loop still hoped.

**Vendor their nine modules, awakening, or Dense Track.** Rejected. The product uses the J-Space name and a rewritten ledger/protocol. Shipping their `SKILL.md` and ritual would imply a mechanism we do not implement, and Anthropic’s J-space is an activation subspace read by a Jacobian probe, not a markdown protocol.

**Sibling repo + seat, like Shield.** Rejected for v1. Shield’s payload is a paid detection engine that must not live in this tree. A working card is model-visible session state and belongs in the session log here. Extract a payload later only if the control protocol versions independently of the harness.

**Default `enabled: true` and `mode: always-open`.** Rejected because that reprints a card on every chat, including one-step questions, and taxes tokens. Security screening defaults on; a working card does not.

**Replace todo and GoalBar in the first ship.** Rejected because those surfaces have shipped projections, snapshots, and a documented turn-boundary lifetime. The card ships beside them.

**Classify `fast` / `full` / `loop` by forking the agent loop.** Rejected. Pass intensity is Settings `mode` plus last-human-text classification on assemble. The loop only forwards claimed messages into `AssembleContext`; it does not grow a J-Space phase.

## Consequences

Every `shres-base` profile loads the J-Space seat. Tools, prompt section, command, chip, and dock appear only while `enabled` is true. `enabled` defaults false, so one-step chats pay no card tax until the user opts in.

Reprinting the card on every step costs tokens and breaks the KV prefix when the card changes — including the always-on availability line, which is a permanent prompt change the moment `enabled` flips. `mode: available` keeps one-step chats on the one-line notice.

Coverage refusal only checks that `by` matches configured terms; it cannot tell whether the verifier ran — and `evidence: <callId>` proves an event happened, not that it covered the claim. The line is named `Checked`. The Settings page and the tool README state that limit.

Two clocks for “what are we doing” (todo strip vs J-Space card) remain until a later unification. The dock stays hidden unless a native card is open, and todo clearance is unchanged.

`always-open` on a short session will look like process theater. Leave it off by default.

Forked agents copy the logged card; they never share one. Newly spawned agents start with no card unless `always-open` opens one on the first assemble.

## Testing

Host package specs cover remount, fold/fault, fork-copy, coverage matching (word-bounded ASCII; CJK extras), checkpoint/ship refusals, command parse, and Loader composition. Prompt specs cover classify, assemble-time open, and section rebuild. Client specs cover Settings apply, chip/dock `sessionId` gating, and Trajectory badges. `examples/headless-agent` keyless snapshot `jspace-tools` is the assembled-application transcript. The settings-chrome dialog golden includes the J-Space nav row.

## Deferred

- **W0 measurement** (owner-gated): productivity arm and poisoning chain on the `test_break` rig. The third-party skill's completion and token cost are unmeasured here.
- **Shield voice registration:** `jspace:card` is not yet in the shield repo's authority-spoof set.
- **Identical tool-call retry with diagnosis** when a card is open (`tools/pre-execute` consumer).
- **Unify GoalBar and the todo strip** into this card and change todo’s turn-boundary lifetime. The [todo clearance note](2026-07-28-todo-plan-clears-on-next-turn.md) remains in force.
