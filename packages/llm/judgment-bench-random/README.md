# @shres-code/shres-code-judgment-bench-random

Seeded random-matched judgment engine for the [typed-judgment seam](../judgment/README.md). The [routing measurement](../../../bench/routing/prereg-2026-10.md) composes it as arm N's judge: arm R's judge enters the downgrade candidate at its realized cold-point rate, and arm N answers with a seeded draw at that same rate, so the contrast isolates the judge's discrimination from its entry rate. Nothing mounts it by default; a bench overlay inserts it beside the dispatcher like any other engine.

## Config

| Key | Default | Effect |
|---|---|---|
| `entryRate` | required | Probability that one consult selects the downgrade candidate. Frozen in the experiment's registration before any confirmatory trial. |
| `seed` | required | 32-bit seed of the consult draw stream. Pinned in the run manifest; the same seed replays the same decision sequence. |

Unknown keys fail the load by name.

## Semantics

Each consult that holds a choice question consumes exactly one uniform draw from a mulberry32 stream, in ask order. A draw below `entryRate` selects the non-`keep-current` option; a draw at or above it selects `keep-current`. The answered distribution is fixed (0.98 on the selected option, the remainder spread evenly, confidence 0.98), so the consumer's thresholds see a gate-passing answer whenever the draw selects the candidate and the draw stays the only decision variable. Consults without a choice question consume no draw; score questions return the lowest level and binary questions return 0, so a difficulty gate can never block the entry the draw selected.

Each draw is logged at debug level with its consult index. Every draw is also recoverable by replaying the stream from the seed, which is what the analysis does when it audits a run's realized entry rate.

The engine answers from the stream alone: no credential, no model request, no state serialization. Its egress is `none` and its usage is absent, so judge accounting prices it at zero like the other local engines.

## Known Limitations and Deferred Work

- **Draw source deviates from the ruling until the session correlation lands** — the ruling (`design/pr16-measurement.md` §10.4) is `u = hash(seed, sessionId, turn, step)`, stateless and replayable from the log. This implementation draws from a sequential mulberry32 stream in ask order, which replays only from a fresh process with the same consult sequence. The rework needs the session-correlation source (the seam's `JudgmentInput` carries no session or turn identity); until it lands, do not treat N-trial draws as statelessly replayable.
- **Bench-only posture** — the engine answers a Bernoulli draw, not the asked state. It exists for the random-matched contrast and must not be composed outside a registered experiment.
- **No fitting** — the engine declares `supportsFitting: false`; a consumer that requires tokenizer fitting is refused rather than approximated.
