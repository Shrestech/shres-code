# @shres-code/shres-code-jspace-advisor

Default-off jspace feature that puts a reviewer model on the session. The advisor is a reviewer model seat that watches a bounded fold of the main session — the user-message history (the goal ground truth), the open card, and a short trailing window of tool outcomes — and can (a) redirect the main agent to the user's goal when it drifts and (b) be consulted on demand.

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
| `provider` | — | LLM route provider the reviewer runs on. Required when enabled. |
| `model` | — | Model id on that route. Required when enabled. |
| `subagentProvider` | `spawn` | `ctx.subagents` provider that runs reviewer children. |
| `persona` | built-in | Reviewer persona for the child. |
| `reviewerTools` | `wiki_search`, `wiki_read` | Tool filter opened on the reviewer child. Must be non-empty, and every name must exist in the deployment (the filter rejects unknown names loudly). The session_query family requires a mounted `tool-session-query`. |
| `maxDigestTools` | `12` | Trailing `tool/call` signals the advisory digest retains. |
| `maxDigestChars` | `4000` | Character cap on the rendered advisory digest; the trailing tool window is truncated first. |
| `maxExcerptChars` | `200` | Character cap on each error excerpt. |
| `maxUserMessageChars` | `300` | Character cap on each user message in the digest. |
| `maxUserHistoryChars` | `1500` | Character cap on the retained user-message history; the first message is always retained. |
| `maxAdviceChars` | `1000` | Character cap on recorded advice and redirect text. |
| `errorBurst` | `2` | Consecutive errored tool results that count as a proactive trigger. |
| `driftEverySteps` | `8` | Drift-check cadence in completed model steps since the last advice. |
| `advisorySectionOrder` | `56` | Order of the `jspace:advisor` prompt section. |
| `proactive` | `true` | Enable proactive reviews. |

`enabled` requires `provider` and `model`; a missing pair fails loud at load. The advisor engages only a root session the jspace seat has already engaged with an open card.

## How it works

- Both channels run fresh **one-shot** reviewer children on the configured route (`provider`/`model`) through `subagentProvider`.
- **Consult** (`jspace_consult`) folds the digest, asks the reviewer the caller's question, and returns `{advice, recommendation?}` synchronously as the tool result.
- **Proactive** watches committed session events; on a trigger or the drift cadence it runs a reviewer, awaits the structured verdict `{verdict, advice, redirect?}`, and appends it as a log-only `jspace/advisor` event.
- The digest anchors on the **user-message stream** (U1, U2, … with U1 always retained) — the card Goal is the agent's own claim and can be a placeholder — and renders the trailing tool window last so the digest cap truncates it first.
- The reviewer **judges from the digest**: the persona names it sufficient, forbids reading the reviewer's own log or searching for other sessions, and caps exceptional tool use at one call — every run must end with the structured verdict.
- The **`jspace:advisor` prompt section is the redirect channel**: system-prompt assembly runs on every step, so a verdict completing mid-turn reaches the main model in the same turn; the section survives compaction and frames the advice as untrusted.
- Coalescing is log-derived: one review in flight, and no new review until the user speaks after the latest advice. Failure is contained — a broken reviewer logs a warning and nothing else; plugin disposal aborts in-flight reviews.

## Proactive triggers

| Trigger | Event |
|---|---|
| `charter-fail` | `jspace/charter-run` with `passed: false` (discrimination probes, phase `probe`, are excluded) |
| `ship-attempt` | `jspace/charter-run` with `phase: 'ship'` |
| `goal-epoch` | a `jspace/card` whose Goal changed |
| `error-burst` | `errorBurst` consecutive errored `tool/result`s (interleaved `tool/call`s do not reset the run) |
| `drift-check` | every `driftEverySteps` completed `step/end`s since the last advice |

Every `jspace/advisor` event carries `triggerSeq`; the package invariant companion checks the pointed-at event against a config-free predicate per trigger family, plus strictly increasing drift-check pointers.

## Model Experience

### jspace:advisor section

#### What the model sees

While the seat and advisor are active and a card is open, the latest verdict, framed as untrusted reviewer-model advice: `On track: …` or `Drift: …` plus `Redirect: …` on drift. Empty until the first advice exists.

#### Token effect

Small fixed shape; bounded by the one recorded advice.

#### KV Cache effect

A new `jspace/advisor` event replaces the section text and invalidates the prefix from order 56 onward — at most once per user turn.

### jspace_consult tool

#### What the model sees

`jspace_consult` takes a `question`, folds the current digest, runs the reviewer, and returns `{advice, recommendation?}`. It is advertised only while a card is open and denied at execution otherwise.

#### Token effect

The returned advice appends as `tool/result`.

#### KV Cache effect

Append-only; each consult follows the request prefix.

## Known Limitations and Deferred Work

- **Session-query tools need mounting** — the default `reviewerTools` covers only wiki reads because no shipped bundle mounts `tool-session-query`; a deployment wanting `session_search`/`session_event_search`/`session_event_read` on the reviewer must mount that consumer and add the names to `reviewerTools`.
- **Seat-roster reuse deferred** — the reviewer route is explicit config; reusing the `agent-seats` bindings would need a live seat-reading service (fast-follow).
- **Root sessions only** — delegated children carry their own folds and get no advisor.
- **No settlement notice** — one-shot reviewer runs emit no parent notice by design; the section is the delivery channel.
- **No ACP snapshot yet** — the advisor is default-off and absent from shipped profiles; the deferral rationale is carried in the introducing PR and a keyless stub-provider snapshot is the documented fast-follow.
