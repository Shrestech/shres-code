# @shres-code/shres-code-wiki-librarian

Cheap-model Consumer for `ctx.wiki`. One batched auxiliary `ctx.llm.stream()` call per cycle consolidates session traces into wiki pages. The route is settings `wiki.roles.librarian` → project `config.yaml` → plugin `Config`. Unbound is dormant: the seat never uses the session frontier model.

A `wiki/librarian-request` event is appended before dispatch. Page writes go through `ctx.wiki.writePage` / `appendLog` and therefore log `wiki/page`. A one-line notice is injected via `agent.inject()` when an owner is still live.

Triggers: a successful `jspace_ship`, session dispose, and an optional `ctx.jobs` registration of the same inflight cycle.

## Plugin (namespace: `wiki-librarian`)

```yaml
- id: wiki-librarian
  name: '@shres-code/shres-code-wiki-librarian'
  config:
    timeoutMs: 30000
    maxOutputTokens: 2048
    maxInputBytes: 32000
    maxLogEvents: 40
```

| Field | Default | Meaning |
|---|---|---|
| `provider` / `model` | unbound | Must be supplied together. Last-resort binding after settings and project config. |
| `timeoutMs` | `30000` | Auxiliary request deadline. |
| `maxOutputTokens` | `2048` | Output-token cap. |
| `maxInputBytes` | `32000` | Prompt byte cap; oversize cycles fail without a call. |
| `maxLogEvents` | `40` | Trailing session events included in the prompt. |

## Model Experience

### Via auxiliary wiki-summarize / wiki-extract

#### What the model sees

An independent request with `GenerateOptions.purpose` `'wiki-summarize'` (cycle) or `'wiki-extract'` (explicit helper). The system prompt asks for JSON `{ pages, log, summary }` only. The user prompt lists current pages, lint issues, and sampled session traces. Nothing is injected into the session frontier system prompt.

#### Token effect

Independent: zero until a bound cycle runs. One call per cycle, never per wiki write.

#### KV Cache effect

Independent model request. It does not share a prefix with the session conversation.

## Known Limitations and Deferred Work

- **Unbound is silent** — no dispatch and no frontier fallback. The Settings page states that limit.
- **JSON proposals only** — a non-JSON reply is an empty cycle; the seat does not retry on the frontier model.
- **No wiki→skill graduation** — pages never write skills.
