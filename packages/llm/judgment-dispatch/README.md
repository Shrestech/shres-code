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

`defaultEngine` is required and names a registry id: `typesafe` for [judgment-typesafe](../judgment-typesafe/README.md), `shield` for [judgment-shield](../judgment-shield/README.md), `laya` for [judgment-laya](../judgment-laya/README.md), or `llm:<provider>/<model>` for [judgment-llm](../judgment-llm/README.md). The dispatcher never picks an engine by registration order. A missing or empty value, or an unknown config key, fails the load by name.

## Routing

Each ask resolves one engine id: the `judgment.overrides` entry for the ask's `consumer` when that consumer has declared its id, else `judgment.engine`, whose composition layer is `defaultEngine`. Then:

- An id no provider registered fails `UNCONFIGURED` with `judgment engine "<id>" is not composed`.
- A registered engine whose `status()` is not `ready` fails `UNAVAILABLE` with the state and its detail.
- A ready engine answers, and the result carries `engineId`, the registry id of that engine.

Every failure of a routed ask carries `engineId`, as every answer does: the dispatcher's own `UNCONFIGURED` and `UNAVAILABLE`, and an engine's `JudgmentError`, which keeps its code, message, and cause. Anything else an engine throws breaks the provider contract and reaches the caller unchanged. Consumers treat every failure as their own engine-unavailable path, so an unavailable local engine never becomes a remote ask. `selectedEngine(consumer)` reads the id an ask for that consumer would be routed to.

`ctx.judgment.fittingFor(consumer)` is present while the engine selected for that consumer exposes fitting, and `ctx.judgment.fitting` is the same read for the deployment-wide selection. A consumer that names itself reads its fitting through `fittingFor`, so an override to a fitting engine fits even when the deployment-wide engine does not. Each fitted ask routes by its own `consumer` at ask time: one routed to an engine without fitting fails `UNAVAILABLE`, and every fitted result carries `engineId`.

## Settings

The dispatcher installs the `judgment` section with the composition layer `{ enabled: true, engine: <defaultEngine> }`.

Live-service checks apply only to what a configuration write changes. A write is rejected, naming the field it writes, when it changes `engine` to, or adds or changes an override to, an id no provider registered or an engine whose descriptor names another host (`judgment: engine "laya" requires darwin-arm64`), or when it adds or changes an override for an undeclared consumer. An entry the write leaves unchanged is not re-judged, so a stale override never blocks an unrelated write.

A document the settings file loads or reloads is applied as written, whatever the state of the registry. Rejecting it would keep the previous engine answering with only a warning in the log, which is how a switch away from a remote engine could silently fail. An unregistered selection then fails every ask routed to it with `UNCONFIGURED`, with no fallback, and an override for an undeclared consumer is ignored. After the Loader settles, the dispatcher logs each such condition once at error level, again whenever a later change introduces one, and at info level when one resolves: an engine that registers, or a consumer that declares and whose stored override is then honoured.

```yaml
judgment:
  engine: shield
  overrides:
    worker-escalation: typesafe
```

An override key must be a consumer id that a mounted consumer declared in the registry with `declareJudgmentConsumer`; a write adding or changing any other key is rejected with `judgment: consumer "<key>" does not name itself in judgment asks; this override would have no effect` at `['overrides', <key>]`, and asks ignore a stored override for an undeclared consumer. `worker-escalation`, `compaction-jev`, and `judgment-guardrails` declare themselves. The model router declares `model-router` once its asks carry that consumer id.

## Configuration surfaces

The dispatcher serves the `judgmentEngines` Remote (Host service key `judgmentEnginesRemote`). `judgmentEngines.snapshot()` returns `JudgmentEnginesSnapshot` from `@shres-code/shres-code-judgment-dispatch/types`: every registered engine as a `JudgmentEngineView` — id, label, egress, calibration, fitting support, required host and whether it admits this machine, terms URL, per-tier model ids, destination host, and current state with its detail — in registration order, then the resolved selection `{ enabled, engine, overrides }`, the declared consumer ids, and this machine's platform-architecture pair. The Remote only reads; a configuration surface writes `judgment.engine` through the settings seam, where the write rules above apply.

The dispatcher emits the payload-free `judgment/engines-updated` Host event whenever a new snapshot would differ: an engine registers, unregisters, or announces a status change, a consumer declaration begins or ends, or the `judgment` section commits a new value. The Web assembly forwards the event, so a Client subscribes with `ctx.remote.$on('judgment/engines-updated', …)` and re-reads the snapshot.

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
