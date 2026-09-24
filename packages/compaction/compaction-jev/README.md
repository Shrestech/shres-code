# @shres-code/shres-code-compaction-jev

Jev-backed compaction: [`compaction-basic`](../compaction-basic) with three judgment-backed steps and an exact degradation path. It subclasses `BasicCompactionEngine`, so the automatic listeners, the durable `compaction/start`…`compaction/end` transaction, retention pricing, shrink validation, tool-pairing rules, and the overflow-recovery machinery are the inherited ones — this package changes *which span* is compacted and *what summary* is accepted, and nothing else.

Composition swaps it for the basic row; it ships in no default bundle.

## Config

Every `BasicCompactionConfig` field applies unchanged (`thresholdRatio`, `retainRatio`/`retainTokens`, `summarizationProvider`/`summarizationModel`, `summarizationRoute`, `maxTokens`, `compactionRetries`, `maxOverflowRetries`, `maxSummaryOverflowRetries`, `modelPolicies`, `auto`, `maxPointers`, `pinSeqs`) and is validated by the same resolver, with the same diagnostics. The class's schema restates all of them beside the fields below, so a forced-compaction overlay names one whole config. Unknown keys and wrong types fail plugin load by name.

| Key | Default | Effect |
|---|---|---|
| `tier` | `accurate` | Judgment tier the scoring and verification calls run at. |
| `segmentScoreInstructions` | required | The segment load-bearingness question text. |
| `segmentScoreLevels` | five-level rubric | Ordered levels for that question, lowest first. A score question needs levels, so this is Config on the consumer. |
| `boundaryInstructions` | required | The per-edge boundary question text, phrased as the **hazard**: a high probability means the edge cuts through work that belongs together. |
| `verifyInstructions` | required | The overall draft-quality question text. |
| `verifyChecks` | required | The named binary checks the battery runs beside the overall score (`{ name, instructions }`, at least one, names unique). |
| `verifyScoreLevels` | five-level rubric | Ordered levels for the overall question. |
| `maxSegmentsPerCall` | `4` | Segment questions per judgment ask; a longer span is chunked. |
| `segmentMaxChars` | `2000` | Per-segment character cap for scoring, head and tail kept. |
| `verifyMaxChars` | `6000` | Character cap for the draft plus original region a verification reads. |
| `rescueScore` | `3` | Load-bearingness score at or above which a segment is rescued (on the level scale). |
| `segmentConfidence` | `0.6` | Confidence at or above which a score is trusted. |
| `maxRescues` | `2` | Rescued segments per compaction; `0` disables rescue without asking. |
| `boundaryThreshold` | `0.4` | Boundary hazard probability at or above which an edge is unsafe. |
| `boundaryMargin` | `0.15` | Wobble band below that threshold which also counts as unsafe. |
| `maxBoundaryAdjustment` | `2` | Maximum surface nodes one edge may move outward. |
| `verifyThreshold` | `0.7` | Verify-check probability at or above which a check passes. |
| `verifyMargin` | `0.1` | Wobble band below that threshold treated as **not verified**. |
| `verifyScore` | `4` | Overall score at or above which a draft passes. |
| `escalationProvider`/`escalationModel` | — | The strong route one escalation draft runs on; set together, or omit both for the conversation target. |
| `maxEscalations` | `1` | Escalation drafts after a failed verification. |
| `onVerifyFailure` | `accept-logged` | What a draft that failed every attempt does: keep the better draft and log it, or fail the attempt into the inherited failure machinery. |

## Composition

Disable the basic row and insert this one — the same service key, so nothing else in the tree changes:

```yaml
- id: compaction-basic
  disabled: true
- name: '@shres-code/shres-code-compaction-jev'
  config:
    thresholdRatio: 0.6
    retainRatio: 0.1
    segmentScoreInstructions: >-
      How much does a later turn depend on this segment? Score it on the rubric
      below, using the segment's own text in the state.
    boundaryInstructions: >-
      Does a boundary at this point cut through work that belongs together?
    verifyInstructions: >-
      How well does this summary preserve what a later turn needs?
    verifyChecks:
      - name: constraints
        instructions: Does the summary leave out a constraint the user stated?
      - name: errors
        instructions: Does the summary invent or misstate an error or outcome?
      - name: paths
        instructions: Does the summary name a file or symbol that never appeared?
```

The engine consumes `ctx.judgment` (any provider behind that seam) and treats `judgmentEnabled(ctx.judgment.settings) === false` exactly as an absent engine.

## Selection

The inherited selection is free and always runs first; if it declines, so does this backend. When it selects a span, that span is partitioned into step-bounded, tool-pairing-balanced **segments**, each segment is scored for load-bearingness in asks of at most `maxSegmentsPerCall` questions, and the segments scoring at or above `rescueScore` with at least `segmentConfidence` are **rescued** up to `maxRescues`.

Only rescued segments are compacted. Contiguous ones merge into one sub-span, and the sub-spans compact **tail-most-first**, so the newest rescued work is condensed before the oldest. Each sub-span runs through the inherited overflow-retry and durable-transaction machinery; a sub-span that fails abandons the rest while the sub-spans already committed stay committed.

Before a sub-span is compacted, each of its two edges is judged with one hazard question. A probability at or above `boundaryThreshold`, or inside the `boundaryMargin` band below it, makes the edge unsafe and moves it **outward** to the nearest legal (tool-pairing-balanced) boundary within `maxBoundaryAdjustment` nodes, so an unsure edge keeps content rather than dropping it. Tool pairing is revalidated after every move — the structural rule always wins.

## Verification

Each summary draft is verified before it can replace anything. The battery is one ask whose state is the draft plus the capped original region (`verifyMaxChars`): one binary question per `verifyChecks` entry, all phrased as hazards, plus one overall score question.

A draft is accepted only when **every** check is at or above `verifyThreshold` **and** the overall score is at or above `verifyScore`. Otherwise the cascade escalates once: the draft is re-produced on `escalationProvider`/`escalationModel` (or the conversation target when the pair is absent) and verified again.

`verifyMargin` is the band below `verifyThreshold` that counts as not verified. A battery that fails **only inside that band** does not spend the escalation under `onVerifyFailure: 'accept-logged'` — borderline wobble is not worth a second draft — and the attempt is recorded as `accepted-below-threshold` with the answers intact. When the budget is spent (or the band rule applies), `accept-logged` keeps the better draft by overall score and logs it; `fail-attempt` throws into the inherited failure machinery, so the compaction closes with an error and the conversation surface is untouched.

## Degradation

The judgment steps are strictly additive. With no `ctx.judgment`, with judgment disabled, when an ask fails (`UNAVAILABLE`), when an answer cannot be used (`INVALID_ANSWER`), or when every score is below confidence, the engine runs **exactly the compaction-basic behavior**: the inherited selection and `super.summarize`. The companion events record `degraded: true` with the class, and the degraded run's span and summary are identical to a `BasicCompactionEngine` twin's — that equality is asserted by the package's twin-run diff test.

Degradation is decided before any spend: an absent or disabled engine costs zero judgment calls, and `maxRescues: 0` skips scoring entirely rather than asking and discarding.

## Companion events

Two log-only, append-only session events carry the evidence a bench or a UI needs; the shared `compaction/*` vocabulary is not extended.

- `compaction/selection` — the trigger, whether the selection degraded and why, one fact per segment (`startSeq`, `endSeq`, `score?`, `confidence?`, `disposition`), every boundary move (`edge`, `fromSeq`, `toSeq`, `probability`), and the engine/model/latency when asks ran.
- `compaction/verification` — the compaction id, the attempt index, the draft's provider/model, every battery answer, the verdict (`accepted` | `escalated` | `accepted-below-threshold`), and whether verification degraded.

## Model Experience

### Semantic selection

#### What the model sees

Selection adds auxiliary judgment requests over the same conversation: each ask sends the capped segment texts (with `--- segment <start>..<end> ---` markers) or the sub-span text as its state, plus the consumer's `segmentScoreInstructions`/`boundaryInstructions` as its questions. The summarization request itself is unchanged: it still replays the conversation's own system prompt, tools, and region messages, so the provider's warm prefix is reused.

#### Token effect

Selection adds one small ask per `maxSegmentsPerCall` segments plus one ask per sub-span edge, each carrying bounded state (`segmentMaxChars` per segment) and no generated text beyond typed answers. The compacted region's own token accounting is the inherited one; what changes is which segments are condensed and therefore how many shadowed tokens the summary replaces.

#### KV Cache effect

The selection asks are independent requests against the judgment engine's own model, so they neither read nor extend the conversation's prefix. The summarization call keeps the inherited prefix alignment, which is what preserves the conversation route's cache reuse; a rescue that narrows the span changes which messages the summary replays, and that prefix was already cache-resident for the conversation.

### Verification cascade

#### What the model sees

One battery ask per draft sends the draft summary plus the capped original region, with the consumer's check questions and the overall question. An escalation produces one more summarization draft on the escalation route and one more battery ask. No question text reaches the compacted conversation: the battery is an auxiliary call like the summarizer's.

#### Token effect

The battery's input is the draft plus the capped region (`verifyMaxChars`), and its answers are typed probabilities and scores rather than text. An escalation adds one summarization call on the strong route plus one battery call — the deliberate cost of not trusting a single draft.

#### KV Cache effect

Independent auxiliary requests: the battery neither reads nor extends the conversation prefix. The escalation summary's prefix is the escalated route's own, so it is a cache transition for that route by construction.

## Known Limitations and Deferred Work

- **Adaptive triggering is deferred** — this backend changes *what* survives compaction, not *when* it fires. Bundling the two would confound the compaction bench (whose verifiers measure what survives) against the forced-compaction overlay calibration, so the trigger policy stays with compaction-basic and this package inherits it.
- **The verification event's compaction id comes from the live log** — the inherited transaction does not hand its `CompactionId` to the summarizer, so the event reads the open `compaction/start` from the session. Extending the transaction input would remove that read; it is deferred because it changes the shared Definition's provider contract for one consumer.
- **Escalation reaches the summarizer entry point directly** — `summarizeWithLlm` is exported from compaction-basic for exactly this: `super.summarize` always resolves the conversation target, so an explicit escalation route has no other honest path. A future `summarize(target)` hook would let this return to the subclass hook alone.
- **The boundary question's polarity is consumer-owned** — the seam carries probabilities and no polarity, so `boundaryInstructions` must be phrased as the hazard (a high probability means unsafe). A deployment that phrases it the other way gets the opposite behavior; the config JSDoc states the requirement.
- **A below-confidence selection falls back to the whole baseline span** — when no segment is rescued, the inherited span is compacted rather than nothing, because declining would leave pressure unresolved. A deployment that prefers to compact nothing when the judgment is unsure sets `maxRescues: 0` and disables the semantic path entirely.
- **One battery per verification attempt** — the cascade escalates once by default; `maxEscalations` raises that, and each additional attempt costs one summarization call plus one battery call on the strong route.
