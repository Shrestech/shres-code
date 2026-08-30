# @shres-code/shres-code-jspace-advisor

Default-off jspace feature that puts a background reviewer model on the session. The advisor is a reviewer model seat that watches a bounded fold of the main session — the open card plus a short, token-capped window of tool outcomes — and can (a) proactively flag when the session appears to be going wrong and (b) be consulted on demand by the main session.

## Plugin (namespace: `jspace-advisor`)

```yaml
- id: jspace-advisor
  name: '@shres-code/shres-code-jspace-advisor'
  config:
    enabled: false
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master allow. False keeps the plugin loaded and mounts nothing. |
| `provider` | — | `ctx.subagents` provider that establishes the reviewer child. Required when enabled. |
| `model` | — | Model id on that route. Required when enabled. |
| `persona` | built-in | Reviewer persona for the child. |
| `reviewerTools` | `wiki_search`, `wiki_read`, `session_search`, `session_event_search`, `session_event_read` | Tool filter opened on the reviewer child. Must be non-empty. |
| `maxDigestTools` | `12` | Trailing `tool/call` signals the advisory digest retains. |
| `maxDigestChars` | `4000` | Character cap on the rendered advisory digest. |
| `maxAdviceChars` | `1000` | Character cap on recorded advice. |
| `errorBurst` | `2` | Consecutive errored tool results that count as a proactive trigger. |
| `advisorySectionOrder` | `56` | Order of the `jspace:advisor` prompt section. |
| `proactive` | `true` | Enable proactive reviews. |

`enabled` requires `provider` and `model`; a missing pair fails loud at load. The advisor engages only a session the jspace seat has already engaged with an open card.

## How it works

- `ctx.jspace.engaged(session)` gates everything; the jspace seat owns engagement.
- The plugin remounts from `ctx.jspace.watch(status)` so an off seat unloads the advisor surfaces.
- **Consult** (`jspace_consult`) runs a fresh one-shot child per call via `ctx.subagents.start` with a structured `outputSchema` reply. The digest fully specifies the input, so continuity buys nothing; synchrony and per-call disposal are worth more.
- **Proactive** runs one continuable reviewer child per parent session via `ctx.subagents.startContinuable` + `followup`, woken by the harness on triggers. The reviewer's settlement notice is captured from the parent session log and written as a logged `jspace/advisor` event.
- Each review is seeded with `foldAdvisorDigest`: the rendered card (`formatJspaceCard`), the trailing tool-outcome window, the latest human user intent, and the completed step count, all bounded.

## Proactive triggers

A proactive review runs on a closed trigger set, coalesced to at most one per user turn:

| Trigger | Event |
|---|---|
| `charter-fail` | `jspace/charter-run` with `passed: false` |
| `error-burst` | `errorBurst` consecutive errored `tool/result` |
| `goal-epoch` | a `jspace/card` whose Goal changed |
| `ship-attempt` | `jspace/charter-run` with `phase: 'ship'` |

## Model Experience

### jspace:advisor section

#### What the model sees

While the seat and advisor are active and a card is open, the latest `jspace/advisor` advice, framed as untrusted reviewer-model content — never instructions. When no advice has been recorded, the section is empty.

#### Token effect

Small fixed shape; bounded by the one reviewer advice per recorded review.

#### KV Cache effect

A new `jspace/advisor` event replaces the section text and invalidates the prefix from order 56 onward.

### jspace_consult tool

#### What the model sees

`jspace_consult` takes a `question`, folds the current digest, sends it to a fresh reviewer child, and returns the reviewer's structured `{advice, recommendation?}` reply. The call is gated like the card tools: it refuses a non-agent caller, an inactive seat, and a session with no open card.

#### Token effect

The returned advice appends as `tool/result`.

#### KV Cache effect

Append-only; each consult follows the request prefix.

### Proactive settlement notice

#### What the model sees

Each proactive review's completion wakes the parent with a settlement notice turn (the continuation manager's behavior, not suppressible). The `jspace:advisor` section is the durable echo that survives compaction.

#### Token effect

One notice per proactive review, sized by the reviewer's final message.

#### KV Cache effect

The notice is a parent user message; the section reprint invalidates from order 56.

## Known Limitations and Deferred Work

- **Notice wake per review** — each proactive review wakes the parent with a settlement notice turn; the `jspace:advisor` section is the durable echo.
- **Cold resume needs persistence** — continuable children throw `PERSISTENCE_UNAVAILABLE` without a `sessionPersistence` backend; the advisor fails loud at remount while enabled.
- **Reviewer seats are host-composed** — per-preset seats are not offered.
- **Step-bound trigger deferred** — a `step/end`-after-a-bound trigger is not in v1 because its invariant predicate would depend on advisor Config the companion cannot read without a service.
- **Late-activating providers unsupported** — the advisor preflights provider presence at remount; a provider that registers after load is not retried.
- **No ACP snapshot** — the advisor is default-off and absent from shipped/snapshot profiles; the no-snapshot rationale is stated in the PR.
