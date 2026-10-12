# guard/ — loop-hygiene guard family

Behavioral guard plugins watch the agent loop for unproductive patterns and enforce per-call budgets. A guard is a self-contained consumer of core services and extension points, not a swappable capability.

| Package | Role | ctx key |
|---|---|---|
| [`repeat-tool-reminder/`](repeat-tool-reminder/README.md) | Reminders for repeated tool calls, with an opt-in refusal past a run length | listens on tool and agent events |
| [`step-budget/`](step-budget/README.md) | Ends a turn that proposes more model steps than its budget allows | registers an `agent/pre-step` listener |
| [`timeout-policy/`](timeout-policy/README.md) | Arms per-call tool deadlines as deployment policy | registers a `tools/execute` listener |
| [`shield/`](shield/README.md) | Default-on seat for the paid Shres Shield plugin | `ctx.shield` |

Reminders travel as `additionalContexts` on the `tools/post-execute` decision and are appended as logged plugin-sourced `user/message` events ([tools](../../docs/subsystems/tools.md)). Timeouts are split across `shres-timeout`, capability termination, and this policy layer.

Every enforcing behavior in this family is off unless a deployment configures it: the repeat veto (`vetoThreshold`), the step budget (`maxStepsPerTurn`), and the blanket tool deadline (`defaultTimeoutMs`) all ship neutral, because each one truncates honest work when its ceiling is wrong.

The Shield snapshot vocabulary is [docs/subsystems/guard.md](../../docs/subsystems/guard.md).
