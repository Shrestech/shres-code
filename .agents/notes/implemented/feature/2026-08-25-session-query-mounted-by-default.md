# Agent Note: Session-query tools mount by default on example compositions

Status: implemented

## Problem

The five read-only session-history tools already existed and a dedicated ACP overlay could mount them, but the shipped example compositions left the accessible-memory read path unregistered, so default ACP and headless requests carried neither the tools nor a driver sentence telling the model to query prior events instead of re-deriving them.

That gap is the first cost named in the [long-horizon harness-uplift plan](../../proposed/feature/2026-08-25-long-horizon-harness-uplift.md): external ablations place most long-horizon gains in programmatic read over lossless history, not in a larger always-visible card.

## Decision

`@shres-code/shres-code-tool-session-query` is a default row of [`examples/acp-agent/cordis.yml`](../../../../examples/acp-agent/cordis.yml) and [`examples/headless-agent/cordis.yml`](../../../../examples/headless-agent/cordis.yml), with the generic timeout policy mounted beside it.

The ACP app already publishes `ctx.sessionQuery` through its derived SQLite index, so the ACP leaf only mounts the consumer. The headless leaf also mounts `@shres-code/shres-code-session-query-sqlite` at `./.sessions/session-query.db` with the provider default `openAt: startup`, because `agent-spine-demo` does not install that service.

The consumer's `tool:session-query` section is one driver sentence: the full session history is searchable with the five tools, and the model should query prior events before re-deriving facts, decisions, or tool output it has already produced.

Inclusive seq-range filters already existed on the search tools (`event_seq_from`/`event_seq_to` and `seq_from`/`seq_to`) and on the trusted `kind: 'seq'` event filter. Their model-facing descriptions now name J-Space's `goalOpenedSeq` as the natural lower bound for current-goal-epoch scoping. Session-query stays J-Space-agnostic; the coupling is that description sentence only.

The shipped TUI and Web bundles still omit the model-facing consumer, as [session-search-not-shipped-default](2026-08-02-session-search-not-shipped-default.md) records for those surfaces. The dedicated [`session-query.cordis.yml`](../../../../examples/acp-agent/session-query.cordis.yml) overlay now adds only spill storage; the tools come from the included base, so the spill scenario reuses the default `text-turn` prompt and tool-schema sidecars.

## Alternatives considered

- **Mount the consumer on the shared base bundle as well** — rejected for this workstream. The [not-shipped-default decision](2026-08-02-session-search-not-shipped-default.md) still owns the TUI/Web roster, the shared base keeps `session-query-sqlite` at `openAt: never`, and remounting the five schemas on every product surface is a separate product choice.
- **Put the driver sentence only in the J-Space protocol module** — rejected because another workstream owns `packages/jspace/jspace` and `tool-jspace`, and the read path must drive even when the J-Space seat is off.
- **Add a J-Space-coupled epoch filter kind to `ctx.sessionQuery`** — rejected because the existing inclusive seq range already scopes a Goal epoch, and a typed J-Space dependency would invert the ownership the plan requires.
- **Re-record snapshot scenarios instead of hand-updating fixtures** — rejected because recording needs `DEEPSEEK_API_KEY`; keyless expected-text files are the same-PR pin.

## Consequences

Default ACP and headless example requests now carry five additional read-only schemas and one fixed prompt section. Search remains exclusive and count-capped; exact traces and reads stay spill-eligible when a composition also mounts the generic spill policy. TUI and Web default requests are unchanged. Compaction still classifies events as `current` / `shadowed` / `log-only`, and the search tools can request those surfaces, including `log-only` events that have left the model window.
