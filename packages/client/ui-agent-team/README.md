---
description: "Chat-header Team roster panel for sessions that lead an Agent Team."
kind: "package-reference"
---

# @shres-code/shres-code-client-ui-agent-team

## Summary

This plugin adds a `Team` action to the conversation header of sessions that lead an Agent Team. Opening it shows the durable roster — the Lead, each named teammate with its live status and model binding, and provisioning diagnostics — and every teammate row navigates into that teammate's conversation through the stable addressed-subagent path. The panel reads `agentTeams.view` when the header action mounts and again when the panel opens, stores nothing in the browser, and registers no model-facing input; sessions that are not Team Leads render no Team control at all.

## Use this package

The web-app bundle mounts this plugin wherever the Agent Teams runtime is composed; no user configuration exists. Use it to inspect the default Team (Aegis, Stride, Ward, and any custom members) without leaving the conversation, and to open a teammate's transcript the same way the subagent catalog opens one.

### What the panel shows

- Roster rows in creation order: the Lead pinned first, then teammates with status (`running`, `idle`, `unstarted`, `inactive`, `provisioning`, `failed`) and provider/model when bound.
- Failed provisioning keeps its name reserved and shows the durable diagnostic under the row.
- Teammates that are active expose `Open conversation`; the Lead row and unprovisioned template rows do not.

## Understand the implementation

The browser half registers one `conversation.session.header.actions` contribution whose injected face closes over the client connection and session navigation; components never see the connection. The host answers `agentTeams/view` from the exact live Lead, so the panel is a pure read — no Team state is mirrored client-side, and replaying or losing the connection cannot corrupt Team records.

## Model Experience

### Team roster panel and teammate navigation

#### What the model sees

Nothing: every element this package draws is user chrome. Roster reads ride `agentTeams/view`, panel state stays component-local, and teammate navigation reuses the ordinary addressed-subagent conversation path.

#### Token effect

Zero model tokens. Opening, reading, or navigating from the panel adds no prompt section and produces no session events.

#### KV Cache effect

None. No model request changes shape because the panel exists or is used.

## Known Limitations and Deferred Work

- **Reload on open** — the roster loads when the session header action mounts and again when the panel opens, not as a live subscription. A failed read keeps the last successful roster; a first-load failure shows Retry instead of hiding the control. Provisioning started elsewhere becomes visible on the next read.
- **No task board** — the runtime registers no task tools, so the panel is roster-only; task chrome waits on the board runtime.
- **Navigation needs an active teammate** — failed or unprovisioned template rows carry no conversation to open; the row shows status or diagnostics instead.
