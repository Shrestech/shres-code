# @shres-code/shres-code-repeat-tool-reminder

A loop-breaker, not a model-facing tool: it never appears in the tool list, and adds exactly one behavior — it watches each agent's stream of tool calls, counts runs of consecutive calls to the same tool with identical canonicalized arguments, and at configured run lengths injects an escalating advisory reminder telling the model to stop repeating itself, re-read the last result, and either change approach or conclude. Reminders decide nothing: a legitimately repeated call is delayed by nothing and blocked by nothing. A deployment that wants the loop actually stopped sets the opt-in `vetoThreshold`, past which the identical call is refused instead of dispatched. Decision records.

## Config

```yaml
- id: repeat-tool-reminder
  name: '@shres-code/shres-code-repeat-tool-reminder'
  config:
    thresholds: [3, 5, 8]        # default; consecutive counts that trigger a reminder
    include: []                  # tool-name patterns to track; empty ⇒ all tools
    exclude: [todo_write]        # tool-name patterns transparent to the chain
    argumentsPreviewChars: 500   # default; cap on arguments quoted in the detailed reminder
    vetoThreshold: 0             # default; 0 ⇒ advisory only, never refuse
```

`thresholds` fails loud at plugin load: an empty list, a non-integer, a value below 2, or a duplicate throws, never a silent fall-back to defaults; `argumentsPreviewChars` equally rejects anything but an integer >= 1, and `vetoThreshold` anything but `0` or an integer >= 2. The list is normalized to ascending order; the FIRST threshold delivers a short generic nudge, every later threshold delivers the detailed form naming the tool, the run length, and the canonical arguments — head-truncated at `argumentsPreviewChars` with an omitted-count marker, so a looping `write`/`edit` payload cannot ride into the next request unbounded (the chain key always compares the FULL canonical string; the cap bounds the reminder, never the detection).

## Veto escalation

`vetoThreshold` is off by default, so the shipped guard stays advisory. Set it and the guard stops delegating at that run length: the attempt reaching `vetoThreshold`, and every identical attempt after it, is refused with a structured error and the tool never runs.

- **Refusal, not a reminder.** The refused call gets `{ isError: true, error: { message, info: { name: 'RepeatToolVetoError', code: 'REPEAT_TOOL_VETO' } } }`, so a retry, metrics, or transcript consumer routes on the code rather than the prose.
- **It sits on `tools/execute`, not the `tools/pre-execute` deny gate.** A deny reason is a bare string and cannot carry an error code; short-circuiting the dispatch waterfall refuses just as completely while keeping the routable code. The loop still logs the ordinary `tool/call` and `tool/result` pair.
- **A refused call still counts.** Post-execute runs for it, so the run length keeps growing and the call stays refused until the model changes something.
- **Reminders and the veto are independent.** A count that is both a configured threshold and the veto point produces both the reminder context and the refusal; choose distinct numbers (the escalation `thresholds: [3, 5, 8]` with `vetoThreshold: 10` reads as three warnings then a stop).

`include`/`exclude` entries support `*` wildcards and are predicates over whatever tools exist at call time, not references to registry entries — a pattern matching no currently registered tool is NOT an error (`exclude: [mcp_*]` stays valid in a deployment that loads no MCP tools), unlike `toolOrder`'s referent check.

## Chain semantics

The chain key is `(tool name, canonical arguments)` — canonicalization is a deep key-sort plus `JSON.stringify`, so argument objects differing only in property order count as identical. A call identical to the previous tracked call increments the agent's consecutive counter; a different tracked call resets it to 1.

- **Untracked calls are transparent to the chain.** A call excluded by `include`/`exclude` neither increments nor resets the counter, so `grep X → todo_write → grep X` still counts as two consecutive `grep X` when `todo_write` is excluded. This is what makes exclusion useful: bookkeeping tools interleaved into a loop must not launder it.
- **Denied calls count.** Detection sits on `tools/post-execute`, which also runs for calls a `tools/pre-execute` listener denied — a model hammering a denied call is exactly the loop worth breaking.
- **Calls without an agent are ignored.** A direct `ctx.tools.execute()` caller has no model to remind and no live agent object to key on.
- **Per-agent keying.** The tool registry is context-level and subagents interleave through the same waterfall, so a `WeakMap<Agent, Chain>` keys each chain by the live agent object; one agent's repetition never trips another's reminder. A user prompt (`agent/pre-step`) resets the submitting agent's chain, and object lifetime bounds the weak entry without a disposal listener.
- **In-memory only.** A session resumed from persistence starts with a fresh chain — the guard is a heuristic nudge, not a logged invariant, later reminders are the accepted cost.

## Reminder delivery

Reminders ride the post-execute decision's `additionalContexts` (source `{kind: 'plugin', plugin: 'repeat-tool-reminder'}`), never a `content` replacement: the `tool/result` event stays the tool's own output for audit. The loop buffers the context and appends it as an injected `user/message` after the step's tool results, which the session renders as a plain synthetic user message — so the reminder is model-visible, source-attributed, and reconstructable from the session log with no new session event. The guard always delegates via `next()` and prepends its reminder to the downstream decision's context array (both variants — a blocked call still gets the nudge); every entry retains its own source and metadata.

## Model Experience

### First-threshold context message

#### What the model sees

At the first configured consecutive-repeat threshold, that agent receives the reminder below. No tool schema or normal-call text is added.

##### First-threshold reminder

```markdown
You are repeating the exact same tool call with identical arguments. Carefully analyze the previous result before calling again: if the task is not complete, try a different approach or different arguments instead of repeating the call.
```

#### Token effect

Zero tokens before the threshold. The reminder is retained history for that agent.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Later-threshold context message

#### What the model sees

A later threshold receives the detailed reminder template below. A capped argument preview ends exactly `… (+<omitted> more chars)`.

##### Later-threshold reminder

```markdown
Repeated tool call detected:
- tool: <toolName>
- consecutive_calls: <count>
- arguments: <canonicalArguments>
The repeated calls are not making progress. Do not call this tool with these exact arguments again. Inspect the latest result and choose a different action, different arguments, or finish the task if enough evidence has been gathered.
```

#### Token effect

Each reminder is retained history; `argumentsPreviewChars` bounds its data-dependent argument text, while agents keep independent counters.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Conditional tool result

#### What the model sees

Nothing unless `vetoThreshold` is configured and reached. From that run length on, the identical call's result is replaced by the refusal below instead of the tool's output.

##### Veto refusal

```markdown
Error: refused: <toolName> has now been called <count> times in a row with identical arguments and is not making progress. This exact call will keep being refused. Re-read the last result from <toolName>, then call it with different arguments, use a different tool, or finish with what you already know.
```

#### Token effect

Zero tokens below the veto threshold. A refusal is a short fixed retained result and replaces whatever the tool would have returned, so a looping call over a large payload costs less once vetoed than it did before.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Exact-match detection only** — canonicalization is a deep key-sort, so near-identical variants (a tweaked path, extra whitespace inside a value) evade the chain; fuzzy matching is rejected pending evidence of need.
- **Compaction does not reset chains** — a chain spanning a compaction checkpoint keeps counting.
- **The veto never releases** — once a run reaches `vetoThreshold` only a different call or a user prompt clears it; there is no cooldown after which the same call is retried.
- **The veto ends no turn** — a model that alternates between two vetoed calls still burns steps; bounding the turn itself is [`step-budget`](../step-budget/README.md)'s job.
- **No subagent chain-sharing** — chains stay isolated per agent; a parent and its subagent repeating the same call never combine.
- **Legitimate idempotent polling still draws nudges** past the thresholds — the pressure valves are `thresholds`/`exclude` config.
- **Past the highest threshold a chain goes silent** — reminders fire only at exact configured counts, never beyond them.
