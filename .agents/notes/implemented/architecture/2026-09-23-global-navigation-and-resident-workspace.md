# Agent Note: Global navigation preserves the resident workspace

Status: implemented

## Problem

Global configuration and team management need space outside the conversation. Navigation must preserve unsent input and session inspection while allowing independently installed features to contribute settings.

## Decision

The layout frame owns the active global destination and supplies navigation through `shell.navigation`. Workspace columns remain mounted while Teams, Customize, or Settings occupies the content area; the frame hides those columns and sets `inert` so hidden controls cannot receive focus. Returning to Workspace preserves the conversation draft, scroll position, and session inspection state. Global destination selection is transient and does not change the current Session.

The settings shell projects the existing `settings.section` ledger into destinations: `teams` belongs to Teams, `plugins` and `agent-presets` belong to Customize, and other entries belong to Settings. Unknown contributed sections remain visible under Settings. Preference values, roster writes, and provider configuration remain owned by their feature plugins. General preferences and audio preferences use separate additive slots, with each slot declared by the section that renders it.

## Alternatives considered

**Unmount the workspace for each destination.** Unmounting on every settings visit would couple navigation to draft and session-view lifecycles. Keeping global navigation in the frame preserves those lifecycles without introducing a second durable state source.

**Render voice preferences through the General slot from two sections.** A separate audio preference slot gives the audio section exclusive render authority while keeping voice controls owned by the speech plugin.

The [slot system standard](2026-07-22-slot-type-chain-implementation.md) still owns registration and render authority, and the [web client architecture](2026-07-19-gui-web-client-architecture.md) still owns Host and Client responsibilities. Both remain active; this decision adds destination composition without replacing their constraints.

## Consequences

The frame retains workspace memory while a global page is open. Destination selection resets on reload. Plugin-owned preferences remain discoverable without moving their business logic into the shell.

## Validation

Frame tests preserve a populated draft across navigation and assert that hidden workspace controls are inert. Shell tests cover destination grouping, search, focused appearance navigation, section disposal, keyboard return, and onboarding. Browser scenarios exercise the same assembled web composition used by the desktop renderer.
