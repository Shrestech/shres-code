# @shres-code/shres-code-judgment-dispatch

The one `ctx.judgment` implementation in a deployment that composes judgment engines. It provides `ctx.judgmentEngines`, the [judgment](../judgment/README.md) engine registry that each engine provider registers into, and routes every ask to the one engine the `judgment` settings select. It never answers with a different engine.

## Composition

```yaml
- name: '@shres-code/shres-code-judgment-dispatch'
  config:
    defaultEngine: typesafe
- name: '@shres-code/shres-code-judgment-typesafe'
  config:
    apiKeyRef: TYPESAFE_API_KEY
- name: '@shres-code/shres-code-judgment-shield'
  config:
    endpoint: http://127.0.0.1:8765
    models: { fast: shield-fast@1, accurate: shield-accurate@1 }
```

`defaultEngine` is required and names a registry id: `typesafe` for [judgment-typesafe](../judgment-typesafe/README.md), `shield` for [judgment-shield](../judgment-shield/README.md), or `laya` for [judgment-laya](../judgment-laya/README.md). The dispatcher never picks an engine by registration order. A missing or empty value, or an unknown config key, fails the load by name.

## Routing

Each ask resolves one engine id: the `judgment.overrides` entry for the ask's `consumer` when that consumer has declared its id, else `judgment.engine`, whose composition layer is `defaultEngine`. Then:

- An id no provider registered fails `UNCONFIGURED` with `judgment engine "<id>" is not composed`.
- A registered engine whose `status()` is not `ready` fails `UNAVAILABLE` with the state and its detail.
- A ready engine answers, and the result carries `engineId`, the registry id of that engine.

The engine's own failures reach the caller unchanged. Consumers treat every failure as their own engine-unavailable path, so an unavailable local engine never becomes a remote ask.

`ctx.judgment.fitting` is present while the deployment-wide engine exposes fitting, and it routes each fitted ask by its `consumer` the same way. A fitted ask routed to an engine without fitting fails `UNAVAILABLE`, and every fitted result carries `engineId`.

## Settings

The dispatcher installs the `judgment` section with the composition layer `{ enabled: true, engine: <defaultEngine> }`. A write is rejected, naming the field, when it selects an id no provider registered or an engine whose descriptor names another host (`judgment: engine "laya" requires darwin-arm64`). A stored selection is not checked while the section registers, because its engine can register later in the same load; after the Loader settles, the dispatcher logs each selected id that is still unregistered, once per id, and the first ask routed to it fails `UNCONFIGURED`.

```yaml
judgment:
  engine: shield
  overrides:
    worker-escalation: typesafe
```

An override key must be a consumer id that a mounted consumer declared in the registry with `declareJudgmentConsumer`; a write naming any other key is rejected with `judgment: consumer "<key>" does not name itself in judgment asks; this override would have no effect` at `['overrides', <key>]`. The check is skipped while the section registers, because consumers can declare after the stored settings load; after the Loader settles, the dispatcher logs each stored override for an undeclared consumer once, and asks ignore it. `worker-escalation`, `compaction-jev`, and `judgment-guardrails` declare themselves. The model router declares `model-router` once its asks carry that consumer id.

## Model Experience

### Routed judgment ask

#### What the model sees

The selected engine's model receives the consumer's `state` and `questions`, exactly as that engine's provider sends them. The dispatcher adds no text; it decides which engine, and so which model and which host, receives the ask.

#### Token effect

The dispatcher adds no tokens. Input and output token counts are the selected engine's, so switching the engine changes which model tokenizes and bills the ask.

#### KV Cache effect

A judgment ask is independent of the conversation model request, and the dispatcher neither reads nor extends a conversation prefix. Switching engines moves later asks to another engine's own prefix cache.

## Known Limitations and Deferred Work

- **No automatic engine fallback** — a failing selected engine fails the ask; answering with another engine would change decisions under a different calibration. A deployment that wants another engine selects it.
- **Consumers record the answering engine separately** — the result's `engineId` identifies the engine, and the model router does not yet record the selected engine or its operating point on its decisions.
- **Host matching covers one pair** — a descriptor can require `darwin-arm64` or `any`; the check compares `process.platform` and `process.arch` when a selection is written.
- **The model router does not name itself** — its asks carry no `consumer` id and it declares none, so a `model-router` override is rejected and the router follows `judgment.engine`. It declares `model-router` when its asks carry that id.
