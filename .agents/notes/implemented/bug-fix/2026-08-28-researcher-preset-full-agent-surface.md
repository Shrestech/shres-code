# Agent Note: The researcher preset mounts the full agent-plane tool surface

Status: implemented

## Problem

A researcher session in the real app had no file, shell, web, skill, or delegation tools: the transcript shows the agent concluding "this session has no Read/Bash tool" and routing a file read through a J-Space charter check — the only channel it could find that executes against workspace files. The [researcher MVI](../architecture/2026-08-28-researcher-mvi-ledger-verifier-protocol.md) preset carried only its research rows (persona, protocol, tracker/ledger tools, goal, three seats); its header claimed to add the surface "on top of the host plane", but since [per-session agent presets](../architecture/2026-08-03-per-session-agent-presets.md) the host plane carries no model-facing tools at all — the global layer is pinned empty by the Web composition e2e. Two lanes masked it: the keyless micro-cycle snapshot composes its own research surface with stub seats rather than the shipped preset, and `web-agent-presets.e2e.ts` never gained a researcher case — its roster expectation did not even list the preset.

## Decision

`apps/cli/config/agent-presets/researcher/agent.cordis.yml` mirrors `standard`'s full agent plane — shell, filesystem, jobs, skills, plan mode, compaction, delegation, workflows, ask-user, todo, web — and adds the research rows on top. `tool-goal` carries a comment naming its researcher-specific obligation: the design-defense gate keys on the current Goal epoch, so the goal tool is not optional here. `web-agent-presets.e2e.ts` asserts the exact researcher catalog (the standard surface plus `experiment_*`, `ledger_*`, and the aegis/ward/stride seats) and lists `researcher` in the system-root roster, so a dropped row fails red instead of mounting cleanly and contributing nothing.

## Alternatives considered

**Tool-less researcher by design (seats do the work).** Rejected: the cycle requires reading workspace evidence and running experiments, and the observed behavior — the model hunting for any execution channel — is the failure, not a discipline.

**Share the standard rows through `cordis-plugin-include`.** Rejected: a preset directory is a self-contained, copyable unit — deployments copy one and enable its disabled rows; an include of `../standard/` would break the copy and the preset's skill-root derivation, and config patches cannot target entries behind a nested include.

**Restore base tools to the host plane.** Rejected: that reverses the preset architecture's core invariant — a globally registered tool reaches every agent regardless of composition.

## Consequences

Researcher sessions run the cycle against real workspace content with the same capabilities as a standard session. The cost is the known near-copy failure mode across five shipped presets; the mitigation is the exact-catalog assertions, which now cover the two full-surface presets. Combined with [the dependency-surface fix](2026-08-28-preset-plugins-app-dependency-surface.md), the researcher preset now mounts and operates in the real app, not only in the snapshot lane.

## Related

- [Preset plugins resolve from the app dependency surface](2026-08-28-preset-plugins-app-dependency-surface.md) — the sibling gap from the same never-ran-in-the-real-app cause.
- [Researcher MVI](../architecture/2026-08-28-researcher-mvi-ledger-verifier-protocol.md) — owns the research rows this preset adds to the standard surface.
