# terminal/ — persistent PTY capability family

`PTY` stands for **Pseudo-Terminal**（pseudo-shell）. This capability provides persistent, owner-scoped terminal sessions for workflows that require state across tool calls or interactive stdin. PTY complements the one-shot bash and filesystem tools; it does not replace their stronger per-operation contracts.

| Package | Role | ctx key |
|---|---|---|
| [`pty`](terminal/README.md) (`@shres-code/shres-code-terminal`) | Backend registry, branded ids, exact-Agent ownership, session operations, and awaited cleanup | `ctx.terminals` |
| `terminal-bash` (`@shres-code/shres-code-terminal-bash`) | Shell backend over `ctx.subprocess.spawnTerminal`: readiness detection, bounded terminal state, sandbox policy, and session operations | registers on `ctx.terminals` |
| `tool-terminal` (`@shres-code/shres-code-tool-terminal`) | Six model-facing tools and generic task integration for background sends | registers on `ctx.tools` |



The subsystem reference — ids, backend/session contracts, send readiness, bounded reads — is [docs/subsystems/terminal.md](../../docs/subsystems/terminal.md);
