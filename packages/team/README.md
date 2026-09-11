# team/ — Agent Teams coordination

Named peer teammates coordinated from one Lead session through a durable roster, mailbox, and compare-and-set task board. Agent Teams consumes the existing [subagent](../subagent/README.md) delegation seam; it is not folded into that family.

| Package | Role | ctx key |
|---|---|---|
| [`agent-team/`](agent-team/README.md) | Durable vocabulary, Lead-log mailbox, continuable provisioning, steer delivery, `team_send` / `team_list` | `ctx.agentTeams` |

Types and semantics: [the Agent Teams subsystem page](../../docs/subsystems/agent-team.md).
