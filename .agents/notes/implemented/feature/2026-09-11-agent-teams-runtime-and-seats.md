# Agent Note: Agent Teams runtime with seats as the default roster

Status: implemented

## Problem

The `#175` Agent Teams package stored roster, mailbox, and task events but did not spawn teammates, deliver mail, or mount on web. Named Aegis / Stride / Ward seats were generic continuable children. The product needed those seats to be the default Team, YAML extras as additional named members, a Models Subagent seat for anonymous hires, and Team mail that steers rather than waiting for the next turn — without stealing `send_message` / `list_agents` the way DeepSeek Harness's experimental Team profile does.

## Decision

`@shres-code/shres-code-agent-team` owns `ctx.agentTeams`: provision a continuable child after a `team/member` provisioning snapshot, queue `team/message/queued` on the Lead log, land an ordinary `user/message` with `source.kind: 'team-message'` on the target, steer, then `team/message/delivered`. Lead self-delivery steers the exact live root; teammate delivery rides the continuation owner's admitted steer path (`subagents.followup` with `delivery: 'steer'`), so activation ownership and the admission cutoff guard every Lead-to-child edge. Restart retries queued-minus-delivered; the target de-dupes on team id plus message id. Failed spawn release drains tracked descendants through the continuation owner before cancelling the child. A replay fault fails loud (`TEAM_LOG_FAULT`) instead of serving the frozen last-good snapshot.

Bound product seats plus YAML `extras` are the roster template. `aegis` / `stride` / `ward` remain named tools that ensure the teammate exists then Team-steer. Extra members are only `team_send` / `team_list`. `seats.subagent` is the generic hire route and is not a teammate. J-Space Advisor stays a watchdog child and is omitted from `team_list`. Generic `send_message` stays followup / next-turn.

Aegis, Stride, and Ward use the product personas in `agent-seats` `src/roster.ts`; the Models-page Team card binds those seats and the generic Subagent hire, and manages custom `extras` members (name, persona, provider, model). A wrap-text control next to each product-seat role opens that shipped persona. Provider and model writes are field path ops. The Settings dialog's Open-configuration-file control edits the same document. The chat surface is `ui-agent-team`: one conversation-header action that reads `agentTeams.view` — a Lead-session read over `ctx.agentTeams` — and navigates active teammates through the stable addressed-subagent path; non-lead sessions render no Team control.

The base bundle mounts `agent-team` and keeps `tool-subagent-control`. The generic `subagent` tool is remounted by `agent-seats` so an optional `seats.subagent` provider/model can pin the hire route.

## Alternatives considered

**Drop in DeepSeek Harness's experimental agent-team plugin as a package.** Rejected: that plugin is opt-in experimental, steals `send_message` / `list_agents`, exposes model-facing `spawn_teammate`, and inherits the Lead's LLM. Shres already has named seats with per-seat models and still needs generic `send_message` followup. The mailbox and provisioning here are that runtime adapted onto `#175`'s vocabulary, not a second protocol.

**Reuse `send_message` for Team mail, as DSH experimental Teams does.** Rejected because the web and headless compositions still need parent-to-child followup for anonymous hires. Distinct `team_send` / `team_list` names keep the two inboxes.

**Put Advisor on the Team roster.** Rejected: Advisor judges a digest and reprints untrusted advice; it must not steer the Lead as a user message or appear on the task board.

**Model-facing `spawn_teammate`.** Rejected for v1: the grant is Models + YAML.

## Consequences

Every chat that is an ordinary root is an implicit Lead. Binding seats remounts named tools, a template, and a Lead system-prompt section that tells the parent to use `aegis` for architecture and `ward` for review when those seats are bound. The Lead's first `aegis` or `team_send` to that name provisions the child with the assignment as the initial user message and records that assignment as queued then delivered Team mail. A Lead-sent role (the named-seat `prompt` and `team_send` message) shadows `deployment:persona`; tool guidance, teammate `team:policy`, and `deployment:environment` stay. A Lead-sent `cwd` becomes the child's session cwd and AGENTS.md root; omitted inherits the Lead workspace; a cwd after the teammate is active is rejected. Named seat tools and the Lead `tool:agent-seats` section are hidden from the child, remain denied after remount, and in-process composition also shadows `harness:source`. Concurrent first-use of the same name waits for the one in-flight creation. A teammate named-seat or `team_send` call reads the Lead journal and can mail an active or still-creating name; only the Lead starts a missing template member. Failed provisioning still reserves the name. Generic children and Advisor remain outside `team_list`. The chat-header roster reloads when the panel opens; a failed read keeps the last successful roster or shows Retry.
