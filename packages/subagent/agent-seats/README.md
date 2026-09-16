# @shres-code/shres-code-agent-seats

Product roster for **Aegis** (Architect), **Stride** (Worker), and **Ward** (Reviewer) as Agent Team teammates, plus a **Subagent** hire route that is not a teammate. YAML `extras` add named teammates reachable only through `team_send`. Bound product seats remount named tools that provision then Team-steer when `ctx.agentTeams` is present.

The plugin registers the `agent-seats` settings section. A product seat mounts only when both provider and model are non-empty. Aegis, Stride, and Ward ship child personas in `src/roster.ts`; those seats have no settings persona field. When Agent Teams is present, the Lead's first named-seat `prompt` is that teammate's first user message and shadows `deployment:persona`. `description` is only a short label. Optional `cwd` becomes the teammate's session cwd and AGENTS.md root; omitted inherits the Lead workspace. Bound Architect and Reviewer seats also register a Lead `tool:agent-seats` system-prompt section that tells the parent to use those seats for architecture and review and to pass `cwd` when the assignment is another repository. Teammates do not receive named seat tools. `seats.subagent` pins the generic `subagent` tool's route when both fields are set; otherwise that hire inherits the parent route.

| Seat | Role | Tool name |
|---|---|---|
| Aegis | Architect — design and plan, do not implement | `aegis` |
| Stride | Worker — bounded implementation | `stride` |
| Ward | Reviewer — report findings, do not rewrite unless asked | `ward` |

The Models page Team card writes this section: provider/model pickers for the product seats and the generic hire, custom-member management (name, persona, provider, model), and the Settings dialog's Open-configuration-file control over the same document.

## Model Experience

Indirectly, through the named seat tools this plugin remounts and the Lead `tool:agent-seats` section those tools add.

#### KV Cache effect

Prefix-stable while the bound set, descriptions, and child models are unchanged. Binding, unbinding, or rebinding a seat remounts that tool definition and the Lead section and invalidates parent reuse from the first changed tool.

## Known Limitations and Deferred Work

- **Seats are host-global** — they register on the process tool registry, so every agent that inherits global tools sees the bound set. Per-preset seats are not offered.
- **A rebound seat does not migrate a running child** — in-flight children keep the model they started with; the next delegation uses the new binding.
- **YAML extras** — `extras: [{ name, persona, provider, model }]` in this section. Names cannot be `aegis`, `stride`, `ward`, `subagent`, or `lead`.
