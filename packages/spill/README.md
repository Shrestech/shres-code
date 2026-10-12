# spill/ — tool-output spill capability family

This family persists oversized tool output and replaces the inline result with a bounded preview and retrieval locator.

| Package | Role | ctx key |
|---|---|---|
| [`spill/`](spill/README.md) | Defines spill storage | `ctx.spillStore` |
| [`spill-local/`](spill-local/README.md) | Stores spilled text in session-scoped local files | registers on `ctx.spillStore` |
| [`spill-policy/`](spill-policy/README.md) | Applies the post-execution spill policy | listens on `ctx.tools` |

See the tool-output spill decision for the boundary between storage, retention, and tool-owned output handling.

The subsystem reference — `SaveTextSpill`, owners/sources, the branded locator — is [docs/subsystems/spill.md](../../docs/subsystems/spill.md);
