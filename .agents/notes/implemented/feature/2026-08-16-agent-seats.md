# Agent Note: Named Aegis, Stride, and Ward seats

Status: implemented

## Problem

The conversation model is one conductor. Users wanted other enabled providers assigned to named child seats — same workspace and tools, not product CLIs — so the conductor can delegate design, implementation, and review without a "Think harder" slot.

## Decision

Three shield-named seats remount `tool-subagent` spawn instances from the `agent-seats` settings section:

- **Aegis** (Architect) — design and plan; does not implement.
- **Stride** (Worker) — bounded implementation.
- **Ward** (Reviewer) — report findings; does not rewrite unless asked.

Each bound seat is a Shres child (`provider: spawn` plus `agentOptions.provider` / `agentOptions.model`). A seat mounts only when both fields are set. The Models page card writes the section and shows the role name plus a one-line description next to the seat name.

While a seat (or any subagent) is working, the catalog trigger and running rows show a tiny hopping product mark. Aegis is ochre, Stride is green, Ward is blue; an unlabeled running child uses the current text color.

## Alternatives considered

**Product CLI seats (Grok / Claude / Codex as the child runtime).** Rejected: the user wanted Shres children that share this workspace and tool layer, not a second product process.

**Think harder as a fourth seat.** Rejected: effort is a model dropdown, not a delegate.

**Hang seats on `agent-default-model`.** Rejected: that namespace is the conductor's default; seats are a separate roster.

**Per-preset seat remounts.** Rejected: settings registration is process-global, and the roster is a product assignment, not a preset choice.

## Consequences

Bound seats register as global tools, so every agent that inherits the host tool set can see them. Rebinding a seat does not migrate an in-flight child. Catalog coloring keys on the `Aegis:` / `Stride:` / `Ward:` label prefix, not on role words such as `worker`.
