# @roos-code/roos-code-agent-seats

Product roster that remounts three named spawn children — **Boomer** (Architect), **Joey** (Worker), and **Flyer** (Reviewer) — as distinct `tool-subagent` instances. The conversation model stays the conductor. Each bound seat is a Roos child in the same workspace, routed through `provider: spawn` with that seat's stored `agentOptions.provider` / `agentOptions.model`.

The plugin registers the `agent-seats` settings section. A seat mounts only when both fields are non-empty; an omitted or cleared seat withdraws its tool. Settings changes remount the bound set in place. Default composition leaves every seat unbound.

| Seat | Role | Tool name |
|---|---|---|
| Boomer | Architect — design and plan, do not implement | `boomer` |
| Joey | Worker — bounded implementation | `joey` |
| Flyer | Reviewer — report findings, do not rewrite unless asked | `flyer` |

The Models page writes this section. Child personas and tool descriptions live in `src/roster.ts`.

## Model Experience

Indirectly, through the `tool-subagent` instances this plugin remounts; that package owns each seat's schema, prompt section, and result.

#### KV Cache effect

Prefix-stable while the bound set, descriptions, and child models are unchanged. Binding, unbinding, or rebinding a seat remounts that tool definition and invalidates parent reuse from the first changed tool.

## Known Limitations and Deferred Work

- **Seats are host-global** — they register on the process tool registry, so every agent that inherits global tools sees the bound set. Per-preset seats are not offered.
- **A rebound seat does not migrate a running child** — in-flight children keep the model they started with; the next delegation uses the new binding.
