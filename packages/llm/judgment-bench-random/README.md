# @shres-code/shres-code-judgment-bench-random

Seeded random-matched judgment engine for the [typed-judgment seam](../judgment/README.md). The [routing measurement](../../../bench/routing/prereg-2026-10.md) composes it as arm N's judge: arm R's judge enters the downgrade candidate at its realized cold-point rate, and arm N answers with a seeded draw at that same rate, so the contrast isolates the judge's discrimination from its entry rate. Nothing mounts it by default; a bench overlay inserts it beside the dispatcher like any other engine.

## Config

| Key | Default | Effect |
|---|---|---|
| `entryRate` | required | Probability that one consult selects the downgrade candidate. Frozen in the experiment's registration before any confirmatory trial. |
| `seed` | required | 32-bit seed of the consult draw stream. Pinned in the run manifest; the same seed replays the same decision sequence. |

Unknown keys fail the load by name.

## Semantics

One consult that holds a choice question consumes exactly one uniform draw `u = hashDraw(seed, correlation)`, an FNV-1a mix of the seed with `JudgmentInput.correlation` (`sessionId` plus the consumer's `consultKey`) normalized to `[0, 1)`. The same correlation always yields the same draw, and every input is reconstructable from the decision log, so any draw replays from the log alone. A draw below `entryRate` selects the non-`keep-current` option; a draw at or above it selects `keep-current`. The selected answer carries probability 1 and confidence 1 on the chosen option, so the consumer's thresholds always see a gate-passing answer whenever the draw selects the candidate and the draw stays the only decision variable. Consults without a choice question consume no draw: score questions return the lowest level and binary questions return 0, so a difficulty gate can never block the entry the draw selected.

The engine requires the correlation: without it the consult fails with `UNAVAILABLE`, which the router logs as `engine-unavailable`, rather than falling back to any stream or global. Each draw is logged at debug level as a diagnostic. Egress is `none`: no credential, no model request, no state serialization — the asked state is never decoded and the correlation never leaves this machine — and usage is absent, so judge accounting prices it at zero like the other local engines.

## Model Experience

### Judgment ask

#### What the model sees

Nothing reaches a model. The engine is not a model and makes no request: it reads only the ask's `correlation` facts and its `questions` list, answers deterministically from the draw, and never decodes the state text. A composed session shows arm N's judge answering in the same answer shapes the real judge uses — a `kind: "choice"` answer with `probabilities` and `confidence: 1`, a lowest-level `score`, a zero `binary` — so the router's decision log is shape-identical across arms while the selection is pure chance at the matched rate.

#### Token effect

Zero. The engine reports no `usage`, bills nothing, and adds no tokens to any arm's accounting; the contrast between arms R and N is the judge's discrimination, not spend.

#### KV Cache effect

None. The engine makes no request, so it reads no provider cache and writes none; its `egress: "none"` descriptor keeps every ask on this machine, and any cache behavior in an arm's session belongs to the arm's conversation route, never to this judge.

## Known Limitations and Deferred Work

- **Bench-only posture** — the engine answers a Bernoulli draw, not the asked state. It exists for the random-matched contrast and must not be composed outside a registered experiment.
- **No fitting** — the engine declares `supportsFitting: false`; a consumer that requires tokenizer fitting is refused rather than approximated.
