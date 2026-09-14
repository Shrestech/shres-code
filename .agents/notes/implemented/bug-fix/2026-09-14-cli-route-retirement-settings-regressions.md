# Agent Note: CLI-route retirement regressions — sparse toggles sink the bridge, cursor-session invisible

Status: implemented

## Problem

Retiring the shipped delegated CLI routes ([CLI agent bridges](../architecture/2026-08-16-cli-agent-bridges.md)) left three regressions on deployments whose settings predated the retirement:

1. `llm-cli-bridge`'s `resolveRoutes` required `displayName` and `binary` on every settings entry, including bare `enabled: false` switch-offs the Models page had written for the shipped routes. One such entry threw for the whole section, and the throw inside the settings `onChange` hook was contained by the inject plumbing — the bridge silently registered zero routes. A deployment whose default model rode a declared CLI route (for example `cursor-cli`) lost it with no diagnostic, and the picker fell back to lookalike routes (`cursor-session` serves the same Cursor model ids but cannot chat).
2. `llm-cursor-session` never registered its configurable-provider directory entry, so the route was invisible on the Models page while remaining selectable in seat pickers, and its `enabled` setting was never honored — the adapter registered unconditionally.
3. The cursor-session wire-gate message named "the delegated cursor-cli route" as the serving path, which the retirement had unshipped.

## Decision

- `resolveRoutes` treats an `enabled: false` entry as a switch, not a declaration: it resolves to a dormant placeholder without requiring `displayName`/`binary`. Placeholders earn no directory card (an empty `binary` is not a valid directory field on the wire), while a disabled route with a full declaration keeps its card. Enabled entries missing either still throw, and a new `validate` hook on the bridge's settings section runs `resolveRoutes` at registration so the failure is loud at the earliest point instead of surfacing as an empty registry.
- `llm-cursor-session` mirrors the grok-session sibling: a directory entry (`settingsNs: llm-cursor-session`) registered once and replaced on display-name change, and a registration keyed on `enabled` so the switch withdraws the live route.
- The gate message now names the hand-declared `cursor-cli` overlay on `llm-cli-bridge` as the completions path, matching what [the cursor subscription session note](../architecture/2026-09-15-cursor-subscription-session.md) records.

## Alternatives considered

**Migrate sparse settings entries to full declarations at read time.** Rejected: the bridge would re-ship the retired route definitions under another name, and the pre-release stance is that stale on-disk shapes are rejected, not interpreted.

**Leave the onChange throw contained and document the empty registry.** Rejected: silent loss of the default model is the worst failure mode; the `validate` hook is the settings seam's sanctioned loud-failure point.

## Consequences

Sections mixing bare switch-offs with declared routes resolve the declared routes; an enabled route without `displayName`/`binary` fails the settings write (or boot) naming the route. `cursor-session` appears on the Models page with a working enable switch. Deployments that relied on a shipped CLI route must declare it as an overlay — the settings repair is mechanical (the retired definition's fields copied into the section).
