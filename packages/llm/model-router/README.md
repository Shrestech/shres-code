# @shres-code/shres-code-model-router

Asymmetric, cache-sticky model routing. The manual or default selection is always the strong model; `candidates` is a **downgrade allowlist**, so this package can select a member of that list or nothing at all — never the manual route and never anything stronger. A typed judgment call decides, a margin gate makes the decision conservative, and a pure fold over the session log holds a downgrade for several turns so the next model transition's prefix re-prefill is amortized.

`ctx.modelRouting` consults `ctx.judgment`, writes two log-only session events (`model-routing/mode`, `model-routing/decision`), folds its state from the log, registers the `/route` command and the `modelRouting` projection, and installs the `model-router` settings namespace. It ships in no default bundle: nothing happens until a deployment composes it.

## Config

Every field is validated at plugin load (and again for a settings write), and unknown keys fail by name.

| Key | Default | Effect |
|---|---|---|
| `initialMode` | required | `on`\|\|`off`: the mode in force before the first `model-routing/mode` event. |
| `candidates` | `[]` | The downgrade allowlist: `{ id, provider, model, reasoningEffort?, description? }`. An empty list keeps every turn on the manual route with `no-candidates` logged. |
| `downgradeThreshold` | required | Route-answer confidence at or above which a candidate may be selected. |
| `downgradeMargin` | required | Required `top1 - top2` probability margin. Both axes are required: a confident-but-close answer is not a downgrade. |
| `routeInstructions` | required | The choice question text asked about the conversation state. |
| `difficultyInstructions` | — | The difficulty question text. Required while `minTurnsDowngraded > 0` or `hardHint` is set, because those read its answer. |
| `difficultyLevels` | five-level rubric | Ordered level descriptions for the score question, lowest first; the count fixes the score scale. |
| `minTurnsDowngraded` | `5` | Turns a downgrade is held before a failed gate may end it. `0` disables stickiness (every turn judged on its own). |
| `escalateBack.scoreThreshold` | `4` | Difficulty score at or above which a held downgrade escalates back immediately. |
| `maxRouteErrors` | `2` | Consecutive durable route failures at which a held downgrade escalates back. |
| `onUnavailable` | `fallback` | `fallback` keeps the manual route and logs the class; `error` logs the `error` outcome instead. |
| `difficultyToEffort` | — | `{ scoreThreshold, reasoningEffort }`: run the selected candidate at this effort on a turn at or above the threshold. |
| `hardHint.scoreThreshold` | — | While the manual route stands, a difficulty score at or above this adds the `consider-stronger` hint to the decision. |
| `state.contextTurns` | `2` | Prior user messages included in the judged state, before the current turn's. |
| `state.maxChars` | `12000` | Hard cap on the assembled state text; older text is dropped from the front. |
| `tier` | `fast` | Judgment tier each call runs at. |

## Composition

```yaml
- name: '@shres-code/shres-code-model-router'
  config:
    initialMode: 'off'
    candidates:
      - id: cheap
        provider: deepseek
        model: deepseek-v4-flash
        description: a small, well-scoped change in familiar code
    downgradeThreshold: 0.8
    downgradeMargin: 0.1
    routeInstructions: >-
      Which route should handle this turn's work? Choose the cheapest route that
      is still a safe fit, or the strongest route when the turn is ambiguous.
    difficultyInstructions: >-
      How hard is this turn for the model handling it?
```

The operating points in that snippet are the documented ones: `>= 0.8` confidence and `>= 0.1` margin sit above the ±0.06 run-to-run wobble measured on borderline classifier answers. `initialMode: 'off'` is the safe starting point — a deployment turns routing on through the `/route` command or a settings write, and a composed-but-off run writes nothing at all to the log, which is what makes it byte-identical to a composition without this package.

## Asymmetric policy

The policy is deliberately one-sided. The manual/default selection is the strong model and `candidates` is an allowlist, so `resolveRequest` can return an allowlisted candidate or nothing: routing can never select the manual route (nothing to do) and can never select anything stronger. The worst case is therefore "a simple turn over-served by the strong model", which costs cents.

That shape is evidence-driven. In the one-day evaluation behind this feature, a prompt-only classifier misrouted two adversarial tasks to the weak model at 0.97 confidence because the trap lived in fixture files rather than in the prompt: symmetric routing ("the classifier picks the model") turns a workspace-blind judgment into a safety decision, while downgrade-only keeps it an economic one. The same evaluation measured the ±0.01–0.06 wobble that the confidence floor and the margin exist to absorb.

Every fallback resolves to the manual route with a logged reason:

| Class | Reason |
|---|---|
| No judgment engine composed | `engine-absent` |
| Engine composed, deployment turned it off | `engine-disabled` |
| Engine unreachable, refused, or timed out | `engine-unavailable` |
| Engine answered with an unusable body | `invalid-answer` |
| No candidates configured | `no-candidates` |
| Chosen route is not on the allowlist | `unknown-candidate` |
| Confidence below the floor | `low-confidence` |
| Top-two margin below the floor | `thin-margin` |
| Chosen candidate is the route already in force | `candidate-equals-base` |

## Sticky fold

A model transition costs a prefix re-prefill at production context sizes (a 250–624K re-prefill, against a per-turn saving of cents), so a downgrade has to persist several turns to net positive. The streak is the hysteresis layer:

- The manual route is **STRONG**. A turn whose route answer passes both gate axes enters **DOWNGRADED(candidate, enteredTurn, entryBase)**.
- While DOWNGRADED the turn is judged as usual and the difficulty question is **mandatory** — a sticky session never runs blind. The judged route is held, not re-decided from scratch.
- DOWNGRADED returns to STRONG when the gate fails and `turnsElapsed >= minTurnsDowngraded` (`gate-failed`), **or immediately at any elapsed count** when the difficulty answer reaches `escalateBack.scoreThreshold` (`escalated`), when the manual provider/model deviates from `entryBase` (`manual-deviation`), when the mode turns off (`mode-off`), or when a durable route-failure streak reaches `maxRouteErrors` (`route-errors`).

The state is a **pure fold** (`stickyState(events, config)`) over `model-routing/decision`, `model-routing/mode`, `request/header`, and turn events. Nothing is held in memory: resume, fork, compaction, and a process restart continue a streak exactly as the live consult left it, and a bench replay sees the same states. `minTurnsDowngraded: 0` collapses the horizon to zero and makes routing non-sticky, which keeps the hysteresis claim falsifiable.

Only the **provider/model comparison** counts when the manual route is compared with `entryBase`: an unrelated change to another part of the request header — a plan-mode toggle rewriting `header.system` — must not end a streak.

While a streak holds, the consumed `request/header` carries the candidate, so a reader that reports the session's model selection asks `stickySelection(agent)` before trusting that header. The answer is the route the streak was entered on, reasoning effort included, folded by the same `stickyState` the consult reads: a resumed, forked, or reconnected session reports the manual route rather than the router's own rewrite, and the manual route stays authoritative for what it owns — assembly, the request when no router resolves one, and the base the next consult compares against.

## Command and projection

`/route` reports the mode and any held streak, `/route on` and `/route off` switch it. Between turns the switch is appended immediately; during an open turn it waits for the next accepted pre-step, exactly like plan mode. The `modelRouting` projection folds the command record, the mode commit, the last decision, the sticky state, and the last entered streak base into one wire value (`{ active, pending, last?, sticky?, lastStrong? }`) so a UI renders the routing mode, and restores a session whose own selection is the routing target, without reading the log itself. The routed model, its confidence, and the streak position render in the trajectory, which folds the decisions themselves.

## Model Experience

### Routed model selection

#### What the model sees

Nothing this package writes. It registers no prompt section, tool, or message: its decision changes which provider/model/effort the loop dispatches the turn to, and the request text is whatever the session already assembled. A downgraded turn is the same conversation served by a different route.

#### Token effect

A downgrade changes the rate a turn's tokens are billed at, not the text of the request; the routed turn's input is tokenized by the candidate's provider, so prompt caching, cache reads, and output pricing follow that route. Route changes are the one thing this package adds to the token picture, and the streak exists to amortize their cost.

#### KV Cache effect

A route change is a cache transition: the first turn after a downgrade re-prefills the context under the new route, which is why `minTurnsDowngraded` defaults to 5 rather than 1. Within a streak the route is stable, so the candidate's own prefix reuse continues; an immediate escalate-back is the deliberate exception, because a hard turn is worth the re-prefill.

### Judgment call

#### What the model sees

When a judgment engine is composed and the mode is on, the router sends the assembled state (the turn's user message plus `state.contextTurns` prior ones, capped at `state.maxChars`) with the configured `routeInstructions`, the allowlist as the choice's options, and — while a streak is held or `hardHint` is configured — the `difficultyInstructions` score question. Every `user/message` on the surface counts as one of those turns, including injected context such as a file-change notice or skill text and a goal continuation round, because that is what the routed turn will see. The judging engine's own Model Experience is documented in its provider package.

#### Token effect

The judgment call is its own small request: the state text plus the question text is its input, and its answers replace generated text. Nothing here adds input to the routed conversation turn.

#### KV Cache effect

The judgment call is an independent request that neither reads nor extends the conversation's prefix. It runs against the engine's model, so it does not touch the conversation route's cache at all.

## Known Limitations and Deferred Work

- **Prompt admission is not blocked** — routing runs after the user message has been committed to the session log, so a downgrade cannot change whether that message was admitted. Blocking or reshaping admission on a judgment is deferred: it would make the request path wait on the engine before durability.
- **No identical-prompt cache** — the same state text is judged again on every turn; nothing here memoizes a decision by `stateHash`. The hash is recorded so a rerun is recognizable, and a cache would need a policy for how long a judgment stays valid.
- **A restart mid-turn re-routes once** — the intra-turn pin lives in memory (`WeakMap`), so a process that restarts between two steps of the same turn judges that turn again. The durable fold keeps the streak, not the pin.
- **The failure trigger names exactly what it counts, and what it misses** — the escalate-back-on-errors trigger counts consecutive `turn/end` reasons of kind `error` whose code is neither `ABORTED` nor `UNKNOWN`: a provider-side failure that ended a turn, which the loop records with the `LlmError` facts verbatim. Three other durable carriers exist and are deliberately not counted, because each one means something other than "the route failed this turn": `llm/retry` events record an attempt the recovery layer scheduled to retry, and a retry that succeeds is not a route failure; the terminal error `assistant/chunk` finish chunk records the same failure but is prunable history; and a turn ending `aborted` records no failure at all. The trigger degrades loudly, not silently, in these cases: a failure a recovery listener absorbs without scheduling a retry — canonically `compaction-basic`'s context-window recovery, whose code is outside the retry layer's default set — leaves no `turn/end` error, so the streak does not advance; a throw the harness flattens to `UNKNOWN` is not attributable to a route; a crash-orphaned turn closes as `interrupted`; and auxiliary calls such as session titling never log a failure at all.
- **One decision per turn, taken at the first request** — later steps reuse it, and a judgment is never re-run because the model wrote more code. A turn that starts easy and turns hard escalates only through the difficulty answer at the next turn boundary.
- **Stated candidates are not verified** — an allowlist entry naming a model the route does not serve fails at the provider, mid-turn, not here.
