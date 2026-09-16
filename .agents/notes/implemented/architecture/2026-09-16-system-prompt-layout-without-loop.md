# Agent Note: System-prompt layout without an agent-loop change

Status: implemented

## Problem

Agent Teams now sends a Lead role as the child's `deployment:persona`. That slot was treated as the child's entire system prompt, so a long Architect brief wiped the shipped seat role without a separate workspace line. Teammates also inherited the Lead session cwd, so `agent-instructions` injected this checkout's `AGENTS.md` when the assignment was another repository. They still saw named seat tools and the global `harness:source` line. DeepSeek Harness already splits persona prefix/suffix, reserves `TEAM_POLICY`, stores the prompt as `system/message` node 0, and optionally updates it in-history. Copying that stack into Shres as one jump would rewrite `agent-loop`, every reconstructable-request consumer, and the `deployment:persona` name while not fixing child cwd.

## Decision

Shres keeps `request/header.system` and the section name `deployment:persona`. The loop still renders the registry and sends `request.system`. Layout changes live in plugins.

`applyChildComposition` shadows `harness:source` and `tool:agent-seats` empty on every in-process child. A Lead-sent role still shadows only `deployment:persona`. Agent Teams installs `deployment:environment` at order `200` and `team:policy` at order `600` on rostered teammates, denies `aegis` / `stride` / `ward` at spawn and by name after remount, and accepts an optional first-provision `cwd` that `resolveRequestedChildCwd` validates as an enterable absolute directory before `childSessionMeta` writes it. Omitted or whitespace `cwd` inherits the parent workspace. A cwd after the teammate is active is rejected. First provision records the assignment as queued then delivered Team mail and stamps that id on the child's first user message; it does not steer a second copy. `team_send` passes the message as the first-provision persona. One-shot `start()` honors request cwd only when the provider advertises `cwd`.

Named `SECTION_ORDERS`, `personaPrefix` / `personaSuffix` config keys, `system/message` as surface node 0, and `systemPromptUpdate: 'in-history'` are not shipped. Those remain later, measured steps. In-history stays a model-route capability; `llm-pi-ai` already maps mid-history `system` to user.

## Alternatives considered

**Port DeepSeek Harness prompt architecture in one change.** Rejected: deleting `header.system` rewrites `agent-loop`, compaction, token-meter, Web inspect, and snapshots, and it does not give a teammate its own instruction root. Shres `SESSION_FORMAT_VERSION` is already `0`, but consumer blast is still the whole join of "what the model saw."

**Do nothing: keep one persona blob and parent cwd inheritance.** Rejected: a Lead Architect brief then either inherits this checkout's `AGENTS.md` or has to restate workspace facts that belong in a later section. Teammates also keep seat tools they must not use.

**Rename `deployment:persona` to `deployment:persona-prefix` in the same change as Teams cwd.** Rejected: every preset, test, and config key would move without changing the role-replacement semantics Teams needs. Keep the name until a dedicated layout rename.

**Register `team:policy` on every implicit Lead.** Rejected: that would change every root session that mounts Agent Teams. Lead guidance stays `tool:agent-seats` when Architect or Reviewer seats are bound.

**Copy DeepSeek Harness first-party prompt prose, `complete` persona mode, or child `harness:source`.** Rejected: those thicken harness identity on a teammate reviewing another repository and do not fix cwd.

## Consequences

Aegis/Ward can take a Lead role and a different repository cwd without a loop change. The child's reconstructable workspace is its session header cwd; instruction discovery follows that path. First-provision mail shares the child's first user-message identity. Later work that moves the prompt onto a `system/message` surface node, or that gates in-history on a catalog row, is a new decision and must not land as a Teams follow-up. Package tests pin teammate-only environment, empty Lead-only shadows, `team:policy` on teammates only, first-provision journal edges, and seat-tool denial. The `team-send` keyless snapshot records provision-then-mailbox identity.
