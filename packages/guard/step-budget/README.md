# @shres-code/shres-code-step-budget

A turn-length backstop, not a model-facing tool: it never appears in the tool list, never inspects a tool call, and adds exactly one behavior — it refuses the first model step a turn proposes past its configured budget, which closes the turn through the loop's existing `agent/pre-step` rejection. Without it nothing in the harness bounds a turn, so a model that keeps calling tools without converging runs until the process, the provider, or the user stops it. Decision record: [the harness-hardening Agent Note](../../../.agents/notes/implemented/feature/2026-08-26-step-budget-and-default-tool-timeout.md).

## Config

```yaml
- id: step-budget
  name: '@shres-code/shres-code-step-budget'
  config:
    maxStepsPerTurn: 0   # default; 0 means unlimited
```

`maxStepsPerTurn` fails loud at plugin load: anything but a non-negative integer throws, never a silent fall-back. `0` is the shipped default and means unlimited — the plugin then registers no listener at all, so an unconfigured deployment behaves exactly as it did before this guard existed. A deployment that wants the backstop sets a positive value; there is no shipped non-zero default because the right ceiling depends on the task mix, and a wrong guess would truncate honest long work.

## What the budget counts

A **step** is one model request plus the tool calls that request makes, numbered by the loop and reset at every `turn/start`. The budget is therefore "how many times may the model be asked to act before this turn gives up", which is the quantity a runaway tool loop grows. It bounds neither tokens, wall time, nor how many turns a session runs.

Per-turn is the only scope offered. The loop numbers steps within a turn and exposes that number on `agent/pre-step`; it publishes no session-lifetime step counter, and a count kept in plugin memory would silently restart on resume or process restart — a cap that quietly forgets is worse than no cap.

## Ending the turn

At the first proposed step past the budget the guard, in order:

1. Appends a log-only `step-budget/exhausted` event (`{ turn, step, limit }`, written `{ ignorable: true }`) so a build without this guard can still read the log.
2. Returns the batch this pre-step already claimed to the inbox. The loop claims before running the waterfall, so a bare rejection would discard tool-result contexts and injected notices that no step ever consumed.
3. Queues the stop notice below with `agent.inject()`, which lands on the next-step list and is claimed by the next turn's first step.
4. Returns `{ kind: 'reject' }` without delegating — a later listener cannot un-exhaust the budget — so the loop closes the turn with `turn/end` `{ kind: 'blocked' }`. ACP reports that turn as `end_turn`.

The guard invents no loop path: rejection at `agent/pre-step` is the same mechanism the Claude Code and Codex hook bridges use to deny a prompt.

## Model Experience

### Stop notice

#### What the model sees

Nothing until the budget fires. The refused step reaches no model, so the stopped turn produces no extra model-visible text; the notice below is claimed by the FIRST step of the next turn, ahead of that turn's prompt.

##### Stop notice

```markdown
Your previous turn stopped after <limit> model steps, the most this session allows in one turn. The work is unfinished and nothing was cancelled. Before continuing, state in one or two sentences what is already done and what remains, then take the single most valuable next action instead of redoing earlier steps.
```

#### Token effect

Zero tokens while a turn stays inside its budget, and the refused step spends no request at all. A stop adds one short retained context to the next turn.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Per-turn only** — there is no session-lifetime or cost budget; a caller that re-prompts after every stop gets a fresh budget each turn (see § What the budget counts).
- **A stop is not a summary** — the turn ends where it stood; the guard neither compacts, checkpoints, nor asks the model to write up its progress before stopping, so recovery depends on the next turn reading the log.
- **The budget cannot be raised for one turn** — `maxStepsPerTurn` is deployment config, and no tool or session state relaxes it for a legitimately long task.
- **Counts steps, not work** — a turn of ten cheap reads and a turn of ten hour-long builds spend the same budget.
