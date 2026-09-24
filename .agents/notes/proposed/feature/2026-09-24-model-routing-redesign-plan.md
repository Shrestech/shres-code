# Agent Note: Model-routing redesign and delivery plan

Status: proposed

This proposal partially supersedes the [2026-09-17 typed-judgment routing and compaction proposal](2026-09-17-jev-judgment-routing-and-compaction.md) in six areas: its per-turn routing entry, the turn-counted stickiness horizon, the flat candidate allowlist, the single composed judgment engine, the Classifier settings card's placement, and the routing arms and decision rules of its bench plan. That proposal remains the plan of record for compaction, the worker difficulty ladder, and chat-surface transparency. Both notes stay active and cross-linked.

This proposal builds on the shipped routing surfaces recorded in [2026-09-20 typed-judgment shipped surfaces](../../implemented/feature/2026-09-20-jev-judgment-routing-shipped.md) and the [2026-09-22 routing choice and difficulty decision](../../implemented/bug-fix/2026-09-22-routing-choice-and-difficulty.md). It does not modify either note; the implementation Agent Notes named in §3.10 and §4.7 record their partial supersession.

## Problem

The model router on PR #195 (branch `feat/jev-judgment-foundation`) has a sound safety design. The candidate allowlist bounds every destination, every uncertainty class falls back to the strong model, and routing state replays purely from the session log. Its routing policy, however, delivers no measured benefit. It adds latency, third-party data egress, and correctness risk.

- **No downgrades.** A live session running on the routing branch logged 17 routing decisions and no downgrade. Each consult added a median 704 ms before the turn's first model request and sent up to 12,000 characters of conversation to the third-party TypeSafe API.
- **Weak signal, wrong unit.** The judge reads at most 12,000 characters, about 1.5% of a 200k-token context, and receives no outcome feedback. Routing is decided per turn, so a turn judged strong at step 1 stays strong for every later step. Long, hard turns, which carry most of the spend, are never downgraded.
- **Correctness.** The review found nine defects and gaps. They include the manual model offered as its own candidate, routed requests that name the manual model in the system prompt, candidates with no cost or strength ordering, and a candidate failure that fails the whole user turn.
- **Cache.** The strong Claude route runs on the 5-minute prompt-cache TTL, and pi-ai omits zero cache reads, so the log cannot distinguish a cache miss from an unreported count. In the live session, 89.7% of Opus cache writes came from five cold events, none of them caused by routing.
- **Objective.** The owner's strong routes are subscriptions, and Ollama Cloud draws on plan credits, so routing's dollar effect is near zero. The value is strong-route quota and latency. Quality is the binding constraint: a downgrade stops paying once about one downgrade in three fails a task the strong model would pass.
- **Measurement.** No routing experiment has run. The bench cost metric sums uncached input and output tokens only, ignoring prices, cache tokens, and judge calls. The pilots were single-turn tasks that every model already solved.
- **Engine choice.** The judgment engine is fixed by which provider plugin the composition mounts. The owner requires routing that sends no conversation data to Jev/TypeSafe, and other users need a Settings choice between Jev, local Laya, and third-party engines.

## Proposal

Where sources disagree, facts in this note take this precedence: the live session log first, then checks against the code and fetched primary sources, then the Laya findings. The Evidence section records the resolved facts. Line references are to commit `f0abff5519` unless stated. Section labels §0–§7 and §R are stable cross-reference labels used by the delivery sequence (§6) and the owner decisions (§7).

The shield prompt-security doctrine and the guard packages are out of scope. `@shres-code/shres-code-judgment-shield`, the local judgment provider, is in scope, used only as a wire client. The doctrine section's prompt churn appears only as the prefix-stability requirement in §2.3.

### 0. Summary of decisions

1. **The existing router's decision safety is kept.** That covers: the allowlist as a ceiling; fail-to-strong on every uncertainty class; the pure log fold shared by the consult and the projection; the decision→header pre-publication invariant; and the byte-identical OFF arm.
2. **Per-turn judged-difficulty entry of the main conversation is not a default policy.** It stays reachable only as `entry.policy: every-turn`, for bench arms.
   - The live data shows 0 downgrades in 17 consults. The judge's best candidate confidence was 0.39 against a 0.8 threshold.
   - Each consult added 704 ms (median) to the critical path of every turn.
   - Quality is the binding constraint: the break-even task-failure rate is about 0.33.
   - Per-turn entry pays those costs on every turn and cannot reach long, hard turns.
3. **The default main-context policy is cold-point switching (d), with verification-driven exits (c).**
   - The router may enter a downgrade only at a *cold point* the log proves: session start with no seeded history, after compaction, after an idle gap longer than the strong route's cache TTL, or right after a manual model switch. At those points the strong prefix is cold anyway, so switching adds no strong-side cache cost; only quality is at stake.
   - The router returns to strong at the next cold point, or immediately on a quality signal: difficulty, a keep-current answer, or a worker-escalation fold firing.
   - Plan mode always forces strong (b). Executing an approved plan is an opt-in entry point.
4. **Routing into subagents (a) is the highest-value lever.** Children have isolated contexts, so routing them causes no main-cache churn, and their delegation prompts are short enough to fit Laya's 512–1,024-token window. Subagent routing gets its own extension point, `subagent/child-route`, and a static policy that needs no judge.
5. **Routing starts only from listed strong routes, each with an objective (e), into one shared pool.** `routeFrom[]` lists every strong route routing may start from, each with `objective: quota | dollars | latency`, and `candidates` is the one owner-edited pool all listed routes draw from (owner decision D-46, design D-48). A route that is not listed is never routed. The router imposes no cost or strength order within the pool (§3.3).
6. **The judgment engine becomes runtime-selectable (R1).** A Definition-owned engine registry (`ctx.judgmentEngines`) and a dispatcher (`judgment-dispatch`) provide `ctx.judgment`, with the selection held in the `judgment` settings namespace. Operating points (threshold and margin) are recorded **per engine**. An engine without one never decides a downgrade.
7. **Laya runs locally (R2)** through a supervised MLX gateway (`judgment-laya` plus `python/laya-gateway`) that speaks the judgment-shield wire.
   - It removes the ~700 ms judge latency (Laya answers in about 7–14 ms), third-party egress, and the dependency on TypeSafe's terms clause (vi).
   - The trade-off is a 512- or 1,024-token context window.
8. **Routing stays off by default everywhere** until the Phase 4 criteria pass (§5.8). Meanwhile, a new `initialMode: shadow` collects decisions without rewriting requests, using Laya only.

### 1. Target architecture

#### 1.1 Keep, change, drop

| Element | Verdict | Notes |
|---|---|---|
| Allowlist as ceiling; fail-to-strong for every uncertainty class | **Keep** | Extended: `routeFrom` bounds where routing starts, and the shared pool bounds where it goes (§3.3). |
| `stickyState` pure fold, shared with the `modelRouting` projection | **Keep** | New fold inputs: cold-point facts recorded on decisions, verification triggers, and cooldowns. All come from logged events or decision fields, never from wall-clock time at replay. |
| Decision→header pre-publication invariant (`invariant.ts`) | **Keep** | Extended to `route-failed` fallback retries (§3.4). |
| OFF arm byte-identical to no router | **Keep** | `shadow` mode writes only an `ignorable: true` event; an off run still writes nothing. |
| `/route` command, `modelRouting` projection, trajectory rows, RoutingChip | **Keep** | The projection adds `coldPoint`, `shadow`, and `selectedEngine`. |
| Per-turn judged entry (`decide()` on step 1 of every turn) | **Demote** to `entry.policy: every-turn` | Bench-only. Default is `cold-points`. |
| Step-scoped re-judging while held | **Change** | Exit checks run every step through cheap deterministic folds (c). The judge re-checks every `hold.recheckEverySteps` steps: default 1 with Laya; set it higher for remote engines. |
| `minTurnsDowngraded` (turn-counted horizon) | **Replace** | `cold-points`: hold until the next cold point, bounded by `hold.maxSteps`. `every-turn`: `hold.minSteps`, counted in steps. |
| Top-level `downgradeThreshold` / `downgradeMargin` | **Replace** | Use `operatingPoints[]` keyed by engine id (§R1.4). |
| `difficultyToEffort` recomputed every step | **Change** | Effort is frozen at streak entry (§3.7). |
| The 12k-character judge window as the only signal | **Change** | Judge input is fitted per engine; verification folds and plan state add signals. |
| TypeSafe as the only engine | **Change** | Engines are registered, and the selection is a setting. |
| Main-conversation routing as the primary lever | **Drop** | Subagent routing (a) and cold points (d) replace it. |

#### 1.2 Policy stack (default configuration after Phase 3)

The layers are evaluated in order, and the first one that forces strong wins:

1. **Manual authority.** `manual-deviation`; a base not listed in `routeFrom` → `base-unlisted`. No judgment runs.
2. **Plan phase (b).** `plan/mode` active → `plan-mode` (kept-strong, no judgment).
3. **Recovery and breakers.** `route-errors` recovery, `reentry-cooldown`, `breaker-open`.
4. **Verification exits (c)** while held. A worker-escalation trigger fired since streak entry → `verification-escalated`.
5. **Entry by cold point (d).** Outside a held streak and not at a cold point: no judgment, no decision event, and the manual route stands (as on the OFF path). At a cold point the judge runs.
6. **Judge check.** Eligibility (including `equals-base`) → engine operating point → difficulty band (entry ceiling / exit threshold) → confidence and margin.
7. **Subagent route (a)** is a separate path, `subagent/child-route`. It evaluates `childPolicies` at spawn and never touches the parent's route.

#### 1.3 Why each of (a)–(e) is or is not the default

- **(a) Subagents and seats.** Adopt; this is the primary cost lever. Children start with a fresh context, so the cold entry is unavoidable anyway. Routing them causes no parent cache churn and, being static, adds no judge latency.
  - Team seats keep explicit roster bindings: manual authority, no routing.
  - Fork children (`subagent_fork`) are never routed, because they inherit a warm parent prefix: caches are per model and per account (Evidence, log statistics).
- **(b) Plan/execute phase.** Adopt two parts: plan mode is a hard strong gate (default on), and executing an approved plan is an opt-in entry point treated like a cold point. The state is already logged (`plan/mode`, `packages/plan/plan-mode/src/index.ts:53`).
- **(c) Verification-driven escalation.** Adopt as the exit signal. It reuses `foldEscalationTriggers` (`packages/team/worker-escalation/src/fold.ts:481`), which is deterministic, log-derived, and free.
- **(d) Cold points only.** Adopt as the default entry and return policy. It removes the verified break-even problem:
  - entry costs nothing on the strong side, because the strong cache is already cold;
  - the return at the next cold point costs nothing extra either;
  - only the quality exits pay a deliberate re-prefill.
- **(e) Per-route objective.** Adopt as a required label on each `routeFrom` entry. The label selects which switch points and candidates are admissible, and it is recorded on every decision.
  - There is no runtime price table: repository policy keeps realized usage as the only runtime cost currency.
  - Prices exist only in the bench's dated price snapshot (§5.1).

## Evidence

### Provenance and archive

- The evidence covers four areas: routing approach, prompt-cache economics, performance and measurement, and behavioral correctness.
- Each claim is checked against the code, the session logs, or primary pages fetched on 2026-09-24: Anthropic prompt caching, pricing, and extended thinking; DeepSeek context caching and pricing; OpenAI prompt caching; the Claude Code model configuration; and the Moonshot, Z.ai, and Ollama pricing pages.
- The live evidence comes from the session log of the demo-home deployment described below.
- The raw research archive is local and not in git: `.run/routing-review-evidence/2026-09-24/` and `~/shres-research/routing-review-2026-09-24.tar.zst`. It contains:
  - the analyst and verified reports (`*.md`, `*.verified.md`);
  - `live-evidence.md` and `laya-findings.md`;
  - the design draft `aegis-plan.md`;
  - the fetched sources;
  - the extraction and verification scripts;
  - the server log;
  - session-log snapshots.

### Live evidence from the routing branch

Session `session-2c8ec18f-5511-462d-a7dc-bc251a0888bf`, 2026-09-23 to 2026-09-24, served by the web server on `127.0.0.1:3081` at branch `feat/jev-judgment-foundation`.

- **Composition.** The server ran with `SHRES_HOME` at the repository's `.run/jev-demo-home`. Its composition mounted `judgment-typesafe` and `model-router` with:
  - `initialMode: "on"` and `tier: "fast"`;
  - `downgradeThreshold: 0.8` and `downgradeMargin: 0.1`;
  - `minTurnsDowngraded: 5` and `escalateBack.scoreThreshold: 3`;
  - `maxRouteErrors: 2` and `onUnavailable: "fallback"`.
- **Candidates.** `flash` = `ollama-cloud/deepseek-v4.1-flash:cloud`, `mid-glm` = `zai/glm-5.3`, `mid-kimi` = `moonshotai/kimi-k3`, `mid-deepseek-pro` = `ollama-cloud/deepseek-v4-pro:cloud`. The route instructions send review of plans, designs, or another model's work to the strong route.
- **Base history.**
  - The session started on `codex-session/gpt-6-astra` at high effort.
  - The user switched manually to `zai/glm-5.3`.
  - The server restarted.
  - The user switched manually to `claude-session/claude-opus-5-5` at xhigh effort.
- **Applicable deployment.** The evidence and this plan apply to the demo-home deployment, with the router composed as described above. `~/.shres/settings.yaml` configures a separate installation, with a `grok-session/grok-4.7` default and no router mounted.

| Time | Base | Reason | Route choice (confidence) | Top-2 probabilities | Difficulty (confidence) | Judge ms |
|---|---|---|---|---|---|---|
| 23:46 | gpt-6-astra | current-preferred | keep-current (0.48) | keep 0.59, flash 0.41 | 0 (1.0) | 497 |
| 10:03 | gpt-6-astra | low-confidence | flash (0.39) | flash 0.52, keep 0.43 | 0.06 (0.95) | 765 |
| 10:05 | glm-5.3 | low-confidence | mid-glm (0.13) | mid-glm 0.57, keep 0.43 | 1.63 (0.11) | 663 |
| 10:12 | glm-5.3 | low-confidence | mid-glm (0.06) | mid-glm 0.53, keep 0.47 | 1.56 (0) | 855 |
| 10:21 | glm-5.3 | low-confidence | mid-glm (0.32) | mid-glm 0.66, keep 0.34 | 2.10 (0.22) | 674 |
| 10:37 | glm-5.3 | current-preferred | keep (0.24) | keep 0.62, mid-glm 0.38 | 2.03 (0.12) | 924 |
| 10:38 | glm-5.3 | current-preferred | keep (0.24) | keep 0.62, mid-glm 0.38 | 0.80 (0.33) | 625 |
| 10:45 | glm-5.3 | current-preferred | keep (0.04) | keep 0.52, mid-glm 0.48 | 2.33 (0.37) | 781 |
| 10:47 | opus-5.5 | current-preferred | keep (0.32) | keep 0.45, ds-pro 0.28 | 2.02 (0.37) | 704 |
| 10:52 | opus-5.5 | difficulty-too-high | keep (0.82) | keep 0.86, ds-pro 0.06 | 3.42 (0.52) | 716 |
| 11:10 | opus-5.5 | current-preferred | keep (0.62) | keep 0.69, ds-pro 0.15 | 2.73 (0.53) | 682 |
| 11:25 | opus-5.5 | current-preferred | keep (0.64) | keep 0.72, kimi 0.08 | 0.96 (0.20) | 684 |
| 11:40 | opus-5.5 | current-preferred | keep (0.69) | keep 0.74, flash 0.10 | 0.62 (0.48) | 697 |
| 12:01 | opus-5.5 | current-preferred | keep (0.87) | keep 0.90, kimi 0.04 | 1.49 (0.33) | 709 |
| 12:08 | opus-5.5 | current-preferred | keep (0.92) | keep 0.94, kimi 0.02 | 1.71 (0) | 717 |
| 12:11 | opus-5.5 | current-preferred | keep (0.92) | keep 0.94, kimi 0.03 | 2.50 (0.48) | 658 |
| 12:18 | opus-5.5 | current-preferred | keep (0.85) | keep 0.88, flash 0.08 | 0.86 (0.28) | 758 |

- **Judge latency.** The engine was `typesafe`, model `jev-1.13.0`. Latency across the 17 calls was 497–924 ms, median 704, mean 712: about 2.6× the 273 ms bench figure. There is one call per turn, on the critical path before step 1.
- **Egress.** Each consult sent up to 12,000 characters of recent conversation (`contextTurns: 2`) to the third-party TypeSafe API.
- **Egress stopped (D-15).** A hot reload of the demo home's `initialMode: off` recorded `model-routing/configuration {active:false}` at 13:16:05 on 2026-09-24. The last TypeSafe consult was at 13:11:52: 22 consults in total, all kept-strong.
- **Trivial turns stayed strong.**
  - "hello": difficulty 0 at confidence 1.0, with keep-current 0.59 against flash 0.41.
  - "check branch and dir": flash 0.52 against keep-current 0.43, but at confidence 0.39.
  - The highest confidence any non-base candidate reached was 0.39, against the 0.8 threshold.
- **The base is one of its own candidates.** On base `glm-5.3`, the judge's top choice was `mid-glm`, the base itself, in 3 of 6 decisions. Eligibility kept `mid-glm` in the question, so the probability of staying on GLM was split between keep-current and `mid-glm`.
- **Keep-current dominated on the Opus base** (0.45 rising to 0.94). This matches the route instruction that review work takes the strong route; this whole segment was review work.

| Model | Steps | Cache-hit ratio | cacheRead | cacheWrite | Output |
|---|---|---|---|---|---|
| gpt-6-astra | 3 | 0.331 | 30,464 | 0 | 144 |
| glm-5.3 | 46 | 0.928 | 3,241,600 | 0 | 39,024 |
| opus-5.5 | 38 | 0.860 | 9,089,149 | 1,473,908 | 91,797 |

The hit ratio is cacheRead / (input + cacheRead + cacheWrite) per step. Warm steps sit at 0.96–1.00. None of the cold events below (hit ratio < 0.1) was caused by routing, which never switched models.

| Time | Model | Cause | Cold tokens |
|---|---|---|---|
| 23:46 | gpt-6-astra | session start | 30.6k |
| 10:03 | gpt-6-astra | overnight idle gap, 37,003 s | 30.6k |
| 10:05 | glm-5.3 | manual switch from gpt-6-astra | 30.6k |
| 10:45 | glm-5.3 | server restart; a conditional system-prompt section (the shield doctrine block) removed at char 1,499 | 124k |
| 10:47 | opus-5.5 | manual switch from glm-5.3 | cacheWrite 204,868 |
| 11:07 | opus-5.5 | idle gap 619 s, over the 5-minute TTL | 262,393 |
| 11:27 | opus-5.5 | idle gap 1,021 s | 287,559 |
| 11:41 | opus-5.5 | idle gap 764 s | 297,607 |
| 11:51 | opus-5.5 | same model; a header change re-inserted the doctrine block at char 1,507, invalidating the whole prefix | 269,146 |

- **Opus cold writes.** The five Opus cold events wrote 1,321,573 of 1,473,908 cache-write tokens (89.7%).
  - Three were 5-minute TTL expiries: 847,559 tokens. A 1-hour TTL would have prevented all three, because every gap was under 3,600 s.
  - One was system-prompt churn: 269,146 tokens.
  - One was a manual model switch: 204,868 tokens.
- **System prompt.** The prompt is about 110k characters.
  - The persona line "You are a coding agent powered by the <model> model" sits at about char 1,415, so each model has a distinct prefix. That is harmless across model switches, because caches are per model.
  - A conditional section at about char 1,500 toggling on the same model invalidates everything after it.
- **Compaction.** None ran in the session.

### Verified economics

Verified list prices (USD per million tokens, peak rates):

| Model | Input / cache miss | Cache write | Cache read | Output |
|---|---|---|---|---|
| Claude Opus 5.5 (API) | 4.00 | 5.00 (5-minute TTL) / 8.00 (1-hour TTL) | 0.20 (0.05×) | 20.00 |
| DeepSeek V4.1 Flash (official and Ollama) | 0.30 | = input | 0.006 | 1.20 |
| DeepSeek V4 Flash (Ollama) | 0.44 | = input | 0.014 | 1.32 |
| GLM-5.3 (Z.ai and Ollama) | 1.40 | = input | 0.26 | 4.40 |
| Kimi K3 (Moonshot) | 3.00 | 3.00 (5-minute) / 6.00 (1-hour) | 0.30 | 15.00 |

- **Price and tokenizer details.**
  - Opus 5 and 4.8 list at $5 input, $0.50 cache read, and $25 output; the Opus 5.5 row above is the one that applies.
  - Off-peak prices are half of peak. For DeepSeek they apply outside 01:00–04:00 and 06:00–10:00 UTC on weekdays; for Ollama, outside 12:00–18:00 UTC on weekdays.
  - Z.ai publishes no cache TTL.
  - Anthropic 4.7-and-later models count about 30% more tokens for the same text, which scales Opus-side dollar figures but leaves break-even step counts nearly unchanged.
- **Warm per-step costs** at 150k context, 3k new input and 1k output per step:
  - Opus 5.5: $0.065;
  - Kimi K3: $0.069;
  - GLM-5.3: $0.048;
  - DeepSeek V4.1 Flash: $0.003.
  - Only DeepSeek-class candidates are downgrades from Opus 5.5. Kimi K3 is an upward move in dollars, and GLM-5.3 costs about the same.
- **Entry cost.** The correct entry penalty is E = C·(w_C − r_C), where C is the context size and w_C and r_C are the candidate's miss/write and read prices. The alternative (p_c − r_s)·C counts the strong model's read saving twice. Entering peak-rate Flash from Opus 5.5 is therefore not cheaper than staying warm ($0.30 > $0.20 per million tokens). It is cheaper only off-peak.
- **Break-even formulas.** Write s for the per-step saving, Δ for new tokens per step, and w_S and r_S for the strong model's write and read prices. Including the strong-side writes a downgrade postpones:
  - warm return: N* = C·(w_C − r_C) / [s − (w_S − r_S)·Δ];
  - expired return: N* = [C·(w_C − r_C) + (w_S − r_S)·C] / [s − (w_S − r_S)·Δ].
  - The postponed-write term is $0.0144 per step at 200k, about 22% of s.
- **Break-even steps**, Opus 5.5 → Flash (warm / expired return):

  | Context | Warm return | Expired return |
  |---|---|---|
  | 50k | 0.71 | 12.3 |
  | 200k | 1.18 | 20.5 |
  | 500k | 1.36 | 23.6 |

  For DeepSeek Pro → Flash, the expired return breaks even at 37 steps and the warm return at about 6.9.
- **Warm window.** A return is warm only if the strong route is used again within its TTL, which Anthropic counts from the start of the last strong request, generation time included. That allows at most about 38 Flash steps. The default 5-turn hold runs about 55 steps, so returns are almost always cold unless the strong route uses the 1-hour TTL.
- **Baseline expiries.** Without routing, the strong cache also expires at 29.4% of turn boundaries and 1.0% of step gaps (start-to-start timing). Counting every such expiry, the expected return cost attributable to routing is about −0.73R, or −$0.52 for Opus 5.5 at 150k. A DeepSeek streak therefore saves strong re-prefills in most interactive sessions. Only the roughly 12.5% of multi-turn sessions with no idle gap pay the full return cost.
- **1-hour TTL.** At Opus prices it nets about +$0.12 per turn at 150k even without routing. Turn gaps exceed 300 s 29.4% of the time and 3,600 s 5.7% of the time.
- **Quality bound.** Routing stops paying once about 0.33 of downgrades fail a task the strong model would pass. An 11-step downgrade that returns to a cold strong cache loses about $0.47.
- **Subscriptions.** The owner's strong routes are subscriptions. Ollama Cloud draws per-token usage from monthly plan credits ($60 Pro, $300 Max), so both sides of a switch can be flat-rate. How subscription quota counts cache writes and reads is unverified.
- **Cache telemetry.** pi-ai omits `cacheReadTokens` when it is 0 (`packages/llm/llm-pi-ai/src/stream.ts:26`), so a miss and an unreported count are indistinguishable.
  - Low apparent Ollama hit ratios are mostly missing telemetry. The field is absent in 90.8% of `deepseek-v4-flash:cloud` records, 97.4% of `glm-5.3-flash:cloud` records, and 67.7% of `deepseek-v4-pro:cloud` records.
  - Where the field is present, the hit ratios are 0.982, 0.896, and 0.973.
- **Log statistics** (683 sessions, 49.6k steps):
  - the first step on a model newly used in a session has a median hit ratio of 0 (n = 66);
  - the second step has a median of 0.958 (n = 64);
  - the first step after compaction has a median of 0.20 (n = 40).
  - Caches are per model and per account, so resumed or forked sessions on the same model start warm.

### Verified correctness findings

- **Mid-turn return to Claude (C1).** It is not a failure on adaptive-thinking routes. Anthropic's extended-thinking documentation: "Adaptive mode relaxes this: no assistant turn needs to start with one. Mid-turn conflicts degrade gracefully … the API doesn't error." Every shipped `claude-session` model (Opus 5.5, Opus 5, Sonnet 5) uses adaptive thinking.
  - The residual is reasoning continuity: the other model's reasoning reaches Claude as plain text.
  - Manual-budget Claude routes get thinking silently disabled after a mid-turn return.
  - The path is latent, because the live session made no downgrade.
- **Defects and gaps.**
  - C2: there is no `agent/request-error` listener, a candidate failure fails the turn, and the failure breaker counts only while a streak is active.
  - C4: there is no re-entry cooldown.
  - C5: compaction summarizes on the routed candidate. This is a trade-off: it reuses the candidate's warm prefix.
  - C6: image handling is conservative.
  - C7: context-window checks exclude smaller windows but do not check prompt plus candidate output against the candidate window.
  - C9: the chip shows the mode only.
  - C10: tool pairing and replay transforms work across switches.
  - Subagents and team seats are never routed.
- **Unverified hypotheses.**
  - C3: Kimi thinking mode may reject history that lacks `reasoning_content`.
  - C8: candidate tool-count limits may reject large tool sets.
- **Medium issues.**
  - M1: the base is offered as its own candidate. During a held streak, an answer naming the duplicate bypasses the current-preferred exit, and sticky-hold keeps the cheap route.
  - M2: routed requests carry the manual model's name in the system prompt.
  - M3: candidates have no cost or strength ordering relative to the base.
- **Low issues.**
  - M4: reasoning continuity loss.
  - M5: manual-budget Claude routes lose thinking after a mid-turn return.
- **Unbounded hold.** Within the entry turn, `turnsElapsed` stays 0, so a downgrade holds for the whole turn however long it runs.
- **Step-1 latency on every turn.** Step 1 of every turn pays eligibility plus judgment latency, even on turns that stay strong.
- **Exit paths.** A downgrade ends on many paths besides keep-current and high difficulty: route errors, `no-candidates`, oversized state or judgment input, unknown candidate, manual deviation, a missing engine or LLM, an ineligible candidate, any engine error, missing answers, `gate-failed` after the horizon, and mode-off.
  - Every judgment failure other than an abort ends the streak and forces a cold strong return, so a flaky judge causes cache churn.
  - No transient tolerance, circuit breaker, or router deadline exists; both judgment providers time out at 30 s.

### Verified performance and measurement findings

- **No routing experiment.** No routing arm has run: `bench/runs` holds 0 `model-routing/decision` events, and `cacheHitShare` is absent from all 630 demo trials.
- **Bench cost metric.** `foldUsage` and `bench/runner/descendants.js:149-163` sum uncached input and output only. The metric is inconsistent across providers: a DeepSeek cold entry counts as a cache miss, while an Anthropic cold return is a cache write and is excluded. DeepSeek Flash used 48% more tokens than GLM-5.3 in the pilot, yet costs about 13–18× less.
- **Pilot power.** The pilots ran 6 tasks × 3 repeats at temperature 0. The effective sample is the 6 distinct tasks, and the Wilson intervals were [0.824, 1] and [0.742, 0.990]. A per-trial wall-clock time exists; time to first token, per-step latency, and judgment latency do not.
- **Threshold calibration.** The 0.8 / 0.1 thresholds come from binary-probability wobble on an injection-detection set. The TypeSafe README states that such a band does not transfer to choice or score questions.
- **Judgment latency share.** It is 3.0–3.5% of step time at 273 ms, 5.5–6.4% at 500 ms, and 10.9–12.8% at 1 s, plus unmeasured eligibility time. At the live 704 ms median, an 8-step downgraded turn adds about 5.6 s.
- **Negligible costs.** The log fold per consult takes a median of 0.37–0.77 ms. The per-step request clone takes 0.73 ms at 177k tokens and 2.80 ms at 770k.
- **Bench design constraints.**
  - Opus rejects any temperature setting.
  - Arms that share prefixes can reuse each other's cache.
  - Cheap-model prices vary by time of day.
  - Anthropic's 20-block lookback can cause misses unrelated to routing.
  - TypeSafe's terms clause (vi) restricts using the service to develop new products.

### The #195 diff and documentation gates

- **Sound mechanisms.** Allowlist enforcement, manual authority, abort handling, replay determinism, the decision→header invariant, and the byte-identical OFF arm.
  - The router suite passes 212 tests; the spine and client routing suites pass 558.
- **Minor open issues.**
  - A base-resolution failure is reported as `candidate-ineligible`.
  - The `/route` status horizon text reads the live configuration.
  - The streak exits `state-too-large`, `engine-unavailable`, and `judgment-input-too-large` carry no `brokenBy` reason.
- **Catalog check failure.** `verify-cordis-catalog` and `verify-doc-graphs` fail repository-wide.
  - Both branches: `ctx.clientModules.fetchBundle` references the unclassified types `Request` and `Response`, inherited from commit `02e374a19f`.
  - On origin/master only: `ctx.cursorCredential.managerFor` references `CursorSessionManager` and `CursorSessionOptions`, which are classified on #195 but not on master. Master therefore has four violations.
  - PR 0 (#202) was written against master to fix both: it added `Request` and `Response` to `FOUNDATION_TYPE_NAMES`, ported #195's `cursorCredential` classification byte-identical (commit `91b8a940a4`), and regenerated the catalogs. It closed unmerged, because the Jev branch already carries that classification and #203 fixed the remaining gates there.
- **CI is off.** GitHub Actions are disabled at the repository level, and the CI workflow has been disabled manually since 2026-08-17, so nothing has enforced the documentation gates.
  - Baseline at origin/master `481ea66c52`: doc-sync passes 15 of 26 gates and fails 11. The failing gates are cordis catalog, doc graphs, config catalog, export jsdoc, type equivalence, markdown wrap, markdown links, package paths, package README model experience, package README limitations, and agent note format.
  - Baseline at #195 (`f0abff5519`): 14 pass and 12 fail, the same 11 gates plus doc refs.
  - Current state: #203 (PR 0b) merged into the Jev branch, which passes 26 of 26 gates. The #195 cleanup commits `2b9bbfd58c`, `c8ef75b2fb`, and `cee6f55279` bring #195 to 17 passed and 9 failed, and every remaining failure is in master's baseline.

### Laya findings

- **Forks.** Both forks were brought level with upstream on 2026-09-24.
  - `parthmstech/laya-mlx` is identical to `mizorewww/laya-mlx` at `0a859518`, the "Sync with upstream v0.3.5" commit.
  - `parthmstech/laya` was re-synced after upstream's release 0.3.12, at 04:23Z to `1a099d9785` (release 0.3.16).
  - Upstream `NandhaKishorM/laya` released 0.3.17 at 04:24Z, so at 04:38Z that fork is one commit behind. Upstream ships several releases an hour, so fork parity does not stay true.
- **PyPI.** `laya` 0.3.17 requires Python 3.10 or later. `laya-mlx` 0.2.0 was uploaded on 2026-09-22 at 06:02Z, 28 minutes after the sync commit `0a859518`, which is the upstream head. The repository has no tags, so the correspondence between that release and commit is inferred. "v0.3.5" names the upstream Laya release the port tracks, not the package version.
- **Licenses.** Apache-2.0 covers the `laya` and `laya-mlx` code, the `convaiinnovations/laya` weights, and the `aac6fef/*-mlx` conversions.
- **laya-mlx runtime.** It is a native MLX Python library, not an HTTP server. It needs Apple Silicon, Python 3.11 or later, and macOS 14 or later.
  - Its API is `laya.load(repo)` followed by `agent.predict(state, {id: {type: choice|score|noul, instructions, criteria}})`. These question kinds match the judgment service's choice, score, and binary questions.
  - Port fidelity: 63 of 63 validation questions matched upstream in both FP32 and FP16. This measures fidelity only, not routing accuracy.
  - The port provides inference and conversion. RLCD training and fine-tuning remain in upstream Laya.
- **Performance** (M3 Max, FP16, one short question, end to end):

  | Model | P50 | Throughput (50 questions) | Peak memory |
  |---|---|---|---|
  | Laya 421M | 13.42 ms | 146.8 q/s | 944 MiB |
  | Multilingual 322M | 7.39 ms | 395 q/s | 688 MiB |

- **Checkpoint pins** (Hugging Face API, 2026-09-24; each context limit covers instructions, options, and state):

  | Model | Full revision | Modified | Context |
  |---|---|---|---|
  | aac6fef/laya-mlx | 20aed815fc6acde75733882e7ec0e3f28aeb9717 | 2026-09-19 | 512 |
  | aac6fef/laya-multilingual-mlx | f2b4faf51023039425946074e2cf1361d2db11d5 | 2026-09-19 | 1,024 |
  | aac6fef/laya-typed-decisions-mlx | f9e501c2080cc57c13d6887820329758f5351125 | 2026-09-19 | 1,024 |
  | convaiinnovations/laya (head) | aa8c91ca088ec597df95a0d1c76b3063cb2ae5e8 | 2026-09-23 | 512 |
  | convaiinnovations/laya-multilingual | 82d57fc4f2d1be3d2caac494045f2ec51d0842f3 | 2026-09-23 | 1,024 |
  | convaiinnovations/laya-typed-decisions | bc76315b568af04bc19f133c8bca9a2b3a2d9905 | 2026-09-23 | 1,024 |

  - 1,024-token MLX checkpoints exist: `aac6fef/laya-typed-decisions-mlx@f9e501c2080cc57c13d6887820329758f5351125` and `aac6fef/laya-multilingual-mlx@f2b4faf51023039425946074e2cf1361d2db11d5`. The base conversion `aac6fef/laya-mlx@20aed815fc6acde75733882e7ec0e3f28aeb9717` is 512 tokens.
  - The upstream head is `convaiinnovations/laya@aa8c91ca088ec597df95a0d1c76b3063cb2ae5e8` (2026-09-23), and it carries `multilingual/` and `typed-decisions/` weight subfolders.
  - **Caveat:** the MLX conversions (2026-09-19) predate the upstream weight updates (2026-09-23). Before pinning, PR 10 must read each conversion's source revision from laya-mlx's `benchmarks/results/hub-publication.json` and re-run the fidelity check locally.
- **Current integration.** `judgment-shield` is a loopback wire client for `/v1/judgments` and `/v1/judgments/fitted` that neither starts nor supervises the model runtime. It is pinned to `convaiinnovations/laya@1c5edc17a7acd8701df6fc341c0d179f1c62c982` in three places:
  - `packages/llm/judgment-shield/README.md:29-30`;
  - `bench/routing/route-shield.patch.yml:20-21`;
  - `packages/llm/model-router/tests/provider-composition.spec.ts:34`.

  Routing uses it only in the opt-in bench arm, where the Laya artifact is a development baseline. The `judgment` settings namespace holds only `{ enabled }`, and no runtime engine switch exists.
- **This Mac.** An Apple M2 Max with 32 GiB, macOS 15.7.9 (arm64), Python 3.11.14, 3.13.9, and 3.14.5, and uv 0.11.23. Neither laya-mlx nor MLX is installed, and no Laya weights are cached. Every laya-mlx prerequisite is met.

## 2. Phase 1: cache prerequisites

All three workstreams are separate PRs into the Jev branch (D-60).

### 2.1 `cacheRetention` in `llm-claude-session`

**Field.** Add `Config.cacheRetention?: 'short' | 'long' | 'none'` in `packages/llm/llm-claude-session/src/config.ts`.
- Schema: `cacheRetention: z.union(['none','short','long'])` in `Config` (line 161).
- `resolveRoute` (line 222) emits `cacheRetention: config.cacheRetention ?? 'short'` in the profile. `PiAiProviderProfile.cacheRetention` already exists (`packages/llm/llm-pi-ai/src/config.ts:181`), and `adapter.ts:133` forwards it.

**Default `'short'`.** This is an explicit resolve of today's pi-ai default, so output stays byte-identical. The explicit value also removes the implicit `PI_CACHE_RETENTION` process-environment override for this route, because explicit beats implicit at package boundaries. The README sentence "sends no cache controls of its own" changes to match.

**Validation.** An unknown value fails at load by name: `llm-claude-session: cacheRetention must be "none", "short", or "long"`. `none` is allowed and documented as disabling prompt caching.

**Deployment setting.** After §2.1.1 verifies it, set `cacheRetention: long` in the demo home and the recommended settings snippet. Do **not** change the code default until the verification passes. The verified economics favour the 1-hour TTL at API prices: +$0.12 per turn net at 150k. The live session lost 847,559 write tokens to three 5-minute expiries, and every one of those gaps was under 3,600 s.

#### 2.1.1 Does subscription OAuth honour the 1-hour TTL?

This is unverified. Add an e2e probe under `packages/llm/llm-claude-session/tests/` (`cache-retention.e2e.ts`, collected only by the e2e configuration). It runs only when `SHRES_E2E_CLAUDE_CACHE_TTL=1` is set (D-24) and self-skips without the Claude credential.

1. Build a prefix of at least 2,048 tokens: a fixed system prompt plus one user message.
2. Send request 1 with `cacheRetention: long`. Assert that the raw response has `usage.cache_creation.ephemeral_1h_input_tokens > 0` and `ephemeral_5m_input_tokens == 0`.
   - pi-ai's `Usage` flattens this breakdown, so read the raw body through pi-ai's response hook if one exists. Otherwise run the probe as a standalone script, `scripts/probe-claude-cache-ttl.ts`, with the same OAuth header set.
3. Wait 6 minutes with no traffic, beyond the 5-minute TTL. Send request 2 with an identical prefix. The probe passes if `cache_read_input_tokens >= prefix`.
4. Negative control: repeat with `short`, and expect `cache_read_input_tokens == 0` after 6 minutes.
5. Record the dated result in the Agent Note.
   - Pass → recommend `long`.
   - Fail, either a 400 or a silent 5-minute behaviour → document "subscription ignores the 1-hour TTL" under Known Limitations. The cold-point policy then assumes a 300 s TTL.
6. Record whether pi-ai sends `ttl: '1h'` only for `api.anthropic.com` base URLs. The claude-session base URL is `api.anthropic.com`, so this should hold; verify it in pi-ai's `dist/api/anthropic-messages.js`.

**Router consumption.** Adapters declare the TTL in model info, so the router reads it instead of duplicating it:
- add `LlmModelInfo.promptCacheTtlMs?: number` in `packages/llm/llm/src/types.ts`;
- claude-session sets `300000` (short) or `3600000` (long);
- unknown means absent. The cold-point policy then treats an idle gap longer than `entry.unknownTtlMs` as cold. That is a router config field, default `300000`.

**Tests.** In `config.spec.ts`:
- `resolves cacheRetention short by default`;
- `forwards cacheRetention long into the pi-ai profile`;
- `rejects an unknown cacheRetention by name`;
- `declares promptCacheTtlMs matching cacheRetention`.

Plus the e2e probe above.

### 2.2 Three-state cache usage telemetry

**Problem.** `mapUsage` in `packages/llm/llm-pi-ai/src/stream.ts:26-27` omits cache fields when they are 0, while `packages/llm/llm-deepseek/src/translate.ts:59` writes them whenever they are defined. The log therefore cannot tell a miss from an unreported count (Evidence, cache telemetry: the field is absent in 67.7–97.4% of Ollama records).

**Design** (aegis ruling on PR 2, D-22). `TokenUsage` in `packages/llm/llm/src/types.ts` keeps its existing optional `cacheReadTokens` and `cacheWriteTokens` fields, and their presence is the documented signal. No field is added or removed, so the session format is unchanged and existing logs still load. The `TokenUsage` JSDoc carries this contract:

> cacheReadTokens and cacheWriteTokens each record whether the provider reported that count. Present (including 0): the provider reported the count for this call. Absent: the provider did not report it; inputTokens may then include cached input. Adapters MUST emit a reported zero and MUST NOT emit an unreported count. The two fields are independent: a provider that reports cache hits but has no write concept omits cacheWriteTokens.

**Adapters.**
- **`llm-pi-ai`.** pi-ai's `Usage` always carries numbers, so each profile declares whether its provider reports cache usage.
  - Add a profile field, `cacheUsage: 'reported' | 'unreported'`.
  - The resolved default depends on the API: `anthropic-messages` and `openai-responses` → `reported`; `openai-completions` → `unreported` unless declared.
  - Each session adapter sets `cacheUsage` explicitly in the profile it builds, rather than relying on the resolved default.
  - An Ollama Cloud profile declares `unreported`, because its August records carried no counts at all.
  - `mapUsage(usage, cacheUsage)` emits both counts, zeros included, when the profile declares `reported`. It omits both when the profile declares `unreported`.
  - Add `XXX(pi-ai upstream)`: request raw provider usage so reportedness can be observed rather than declared.
- **`llm-deepseek`** (`translate.ts:54-59`): when `prompt_cache_hit_tokens` is present, `cacheReadTokens` is present, including 0; when it is absent, the field is omitted. The adapter never emits a count the provider did not report.
- **Other adapters** (codex-session, grok-session, cursor-session, cli-bridge, xai-apikey) each state their mapping explicitly under the same contract. A delegated CLI bridge omits both counts.

**Consumers.** A single helper, `cacheCount(usage, 'read' | 'write')`, lives in `llm`. It returns `undefined` for an absent field, never 0. Every consumer reads cache counts through it, and none reads absence as 0:
- `packages/llm/token-meter/src/usage-projection.ts` and `breakdown-projection.ts` show "cache: not reported" rather than 0%;
- the compaction pressure readers;
- `bench/runner/metrics.js`: `cacheHitShare` excludes unreported calls and reports the unreported share.

**No write-TTL class.** `writeTtl` is dropped; cache writes are not split by TTL.

**Event.** `assistant/message.data.usage` keeps its fields, so no new event is needed.
- TTFT is derivable from the log: the time of the first `assistant/chunk` event minus the time of the `request/header` event for the same turn and step.
- Document that derivation in `docs/subsystems/llm-streaming.md` rather than adding a field.

**Invariant.** `packages/llm/llm/src/invariant.ts` adds a check that every present `cacheReadTokens` or `cacheWriteTokens` on an `assistant/message` usage is a non-negative integer. Absence is valid and means the count was not reported.

**Known limitation.** pi-ai logs written before this change omit zero cache reads, so those zeros read as "not reported".

**Tests.** The ruling (D-22) requires these behaviours:
- pi-ai: a reported profile with 0 reads emits `cacheReadTokens: 0`.
- pi-ai: an unreported profile omits both cache fields.
- `cacheCount` returns `undefined` for an absent field and never 0.
- token-meter: the projection renders "not reported" for absent counts.
- bench: `cacheHitShare` excludes calls with absent fields and reports the unreported share.

The plan's tests that remain valid under presence semantics carry over:
- llm-pi-ai (adapter, conversion, and profile-resolution specs):
  - a route whose protocol reports cache counts emits a reported zero for a miss;
  - a chat-completions route that declares `cacheUsage: reported` reports the parsed counts;
  - a route that declares `unreported` omits both counts, even over a reporting protocol;
  - a catalog protocol with no reporting guarantee resolves to unreported.
- `llm-deepseek`: `absent prompt_cache_hit_tokens is unreported`.
- The token-meter projection specs.

The remaining conditions also need coverage:
- each session adapter declares `cacheUsage` explicitly;
- the invariant rejects a present count that is negative or not an integer.

A keyless snapshot re-record covers any transcript that renders usage. Reported profiles emit zero reads, so check whether the `examples/headless-agent` usage lines change.

### 2.3 Prompt-prefix stability (requirement only)

**Requirement.** For a fixed provider, model, and configuration, the bytes of the cached prefix (tools, then the system prompt, then earlier messages) must not change between steps or turns, and content that toggles during a session must not live in that prefix. Anthropic caches in prefix order (tools → system → messages), so a change anywhere in `system` invalidates every message after it. That holds even if the change sits "after a breakpoint" inside `system`.

**Ordering protects only tools and static sections.** In every provider's cache order, messages follow the system prompt. Ordering conditional sections after static ones therefore protects only the tool schemas and the static system sections: any toggle still invalidates every cached conversation message. The motivating case, the live 269,146-token cold write at 11:51, was mostly messages, so ordering alone would not have prevented it.

**Where toggling text belongs.** The cache-safe home for toggling text is a dynamic context, `ctx.systemPrompt.context()`. The shipped loop evaluates context providers at each assembly and logs them as a sourced runtime-context snapshot at the conversation tail (`packages/core/system-prompt/README.md`), so a toggle changes only the tail and the cached prefix survives. Declaring a system section `conditional` and ordering it last is only the fallback. Its cost is stated: tools and static sections stay cached, but every toggle re-prefills all cached conversation messages.

**Acceptance check.** The check is owned by `packages/core/system-prompt` and is generic, with nothing specific to the doctrine section. It is implemented in PR 3 (#205, commit `adb866aa45`).
- A test, `system-prompt/tests/prefix-stability.spec.ts`, toggles every registered *conditional* section across all combinations and asserts that the rendered bytes before the first conditional section stay identical.
- The section registry gains `stability: 'static' | 'conditional'`. An omitted value means static, so every existing prompt renders byte-identical.
- `assemble()` rejects an effective conditional section ordered at or before a static one, naming both. The rule is skipped while a complete section replaces the prompt.
- Owners of individual conditional sections migrate them separately, outside this plan. Moving the toggling text to `ctx.systemPrompt.context()` is preferred over declaring it `conditional`.

**Persona line.** Removing `{{model}}` (bug 2, §3.2) also makes the prefix model-independent. That is harmless, because caches are per model.

## 3. Phase 2: correctness fixes

These fixes are stacked on #195 and land before it merges. All live in `packages/llm/model-router` unless noted. Each subsection lists the change, config, logging, and tests.

### 3.1 Bug 1: the base is offered as its own candidate

**Change.**
- **Eligibility.** In `eligibility.ts` `assessModelRoutingCandidates` (lines 197-266), add the eligibility reason `'equals-base'` to `ModelRoutingCandidateEligibilityReason` (`types.ts:51`).
  - It applies when `candidate.provider === requirements.provider && candidate.model === requirements.model`, regardless of effort.
  - Effort is ignored because a same-model effort change is a cache transition on Anthropic (§3.7).
- **Route question.** `routeQuestion` (`index.ts:1144-1160`) is built from `eligibleCandidates`, so the duplicate disappears from the question.
- **Defensive fold.** In `decide()`, before `gate()` (`index.ts:953`), an answer naming a candidate whose assessment is `equals-base` is treated as `keep-current`, with reason `current-preferred`. This closes the held-streak path where the duplicate bypassed `current-preferred` and `sticky-hold` kept the cheap route (`index.ts:942-972`).
- **`candidate-equals-base` keeps a narrower meaning (D-19).** It fires only when every configured candidate equals the manual route, and it skips judgment. RoutingChip's idle signal depends on it. When candidates fail for mixed reasons, the decision reports `candidate-ineligible`, with per-assessment `equals-base` reasons. It is a reachable decision reason, not an assertion.
- **No load-time self-listing check.** The shared pool (§3.3) has no per-route lists, so a pool model equal to the manual route is excluded at runtime as `equals-base`.

**Logging.** `candidateEligibility.assessments[].reason: 'equals-base'`.

**Tests.**
- `eligibility.spec.ts`:
  - `excludes a candidate equal to the manual provider/model with reason equals-base`;
  - `excludes a same-model different-effort candidate as equals-base`.
- `controller.spec.ts`:
  - `route question omits the base-equal candidate`;
  - `held streak: an answer naming the base-equal candidate ends the streak as current-preferred`.
- Behaviour: when every configured candidate equals the manual route, the decision is `candidate-equals-base` and no judgment runs; mixed failures report `candidate-ineligible` with per-assessment `equals-base` reasons.
- Keyless snapshot: re-record `model-router-keep-current.cordis.snapshot.yml` with a base-equal candidate configured.

### 3.2 Bug 2: routed requests name the manual model

**Change.** Remove `{{model}}` from the persona lines in `packages/bundle/headless/cordis.patch.yml:10` and `packages/bundle/web-app/cordis.patch.yml:19`. The new line is "You are a coding agent. Your working directory is {{cwd}}." The `model` and `provider` variables remain available to templates.

**Other files with the same persona line.** It also appears in:
- the CLI agent presets: `apps/cli/config/agent-presets/code/agent.cordis.yml:35`, `standard/agent.cordis.yml:28`, and `cordis/agent.cordis.yml:21`;
- the example compositions under `examples/headless-agent/`, including every `model-router-*.cordis.snapshot.yml`, and `examples/acp-agent/`.

The guard below enforces the rule for any template once the router is composed. Together with the bundles, PR 4 updates the three CLI agent presets (code, standard, cordis) and the 9 router snapshot configurations under `examples/headless-agent/`. The ACP example compositions keep the model name, because they do not compose the router.

**Rejected alternatives.**
- Deciding the route before prompt assembly needs an agent-loop change: assembly happens once per turn (`agent.ts:348-353`), and routing is decided per step.
- Rewriting the system prompt per request would violate the rule that `agent/request` listeners change only the config.

**Guard.** `model-router/src/invariant.ts` gains a check that fails with "routed request names the manual model" when a `request/header`'s config differs from the latest manual selection *and* its `header.system` contains the manual model id. This enforces the rule in the operation, for any future template. The check applies only to requests under a downgraded decision; route-error recovery is exempt.

**Tests.**
- `invariant.spec.ts`: `rejects a routed header whose system prompt names the manual model`.
- Re-record every headless and web keyless snapshot whose system prompt changes (`pnpm run test:snapshot:record`).
- Loader test `composition.spec.ts`: `downgraded request system prompt does not name the manual model`.
- The product-visible persona change is owner decision D10. It lands in PR 4 as a separable commit.

### 3.3 Bug 3: no cost or strength ordering

The owner edits one shared candidate pool and enables the strong routes routing may start from (owner decision D-46); the design is D-48.

**Config.**
- `candidates` is the one shared pool: `{ id, provider, model, reasoningEffort?, description }`. Ids are unique, non-empty, and not `keep-current`. `description` is required and at most 160 characters, because every description is sent in every judgment question.
- `routeFrom: [{ provider, model, objective, allowEveryTurn? }]` is a fail-closed allowlist of strong routes, matched on provider and model. `objective` is required on each entry (§4.5).

**Load- and write-time validation.** Each case has a named error: a route listed twice; an unknown objective; a `latency` route with `judgmentDeadlineMs` above 200; a `quota` route under per-turn entry without `allowEveryTurn: true`; and an `initialMode` other than `off` with an empty `routeFrom` (`routeFrom is empty: routing can never run`). The `model-router` settings namespace runs the same resolver on every write, so a write fails with the same messages. A write naming a pool `provider` the llm runtime does not register is rejected with `candidates["x"].provider "p" is not a registered route`. That check builds on PR 8a's settings `validate` cause and `SettingsFieldError`; PR 9b owns it, following 8a's rule: it runs on writes only, never at load, and checks only the fields a write changes.

**Runtime.** Every fail-closed class keeps the strong route:
- `base-unlisted`: the manual route is not in `routeFrom`. No judgment runs, and a held streak whose route is removed ends with `brokenBy: 'base-unlisted'`.
- `no-candidates`: the pool is empty.
- `candidate-ineligible`: nothing remains after `equals-base` (§3.1) and the capability checks.
- `engine-uncalibrated`: the selected engine has no operating point (PR 8b).

A pool edit takes effect at the next decision, and a held candidate removed from the pool ends its streak with `unknown-candidate`. Every decision records `candidateEligibility` and the matched entry's `objective`, so an edit cannot reinterpret history.

**Unprotected by owner choice.** A pool model can be a lateral or upward move from some listed route, because the router imposes no cost or strength order. The card (PR 9b) shows two warnings, not errors: a pool model that is also a `routeFrom` route, and a pool model whose declared context window is smaller than a listed route's.

**Tests.**
- `config.spec.ts`:
  - `routeFrom rejects duplicate and invalid objective`;
  - `latency objective requires deadline <= 200`;
  - `quota base refuses every-turn without allowEveryTurn`;
  - `refuses an empty routeFrom unless routing starts off`;
  - `requires a description of at most 160 characters on every pool candidate`.
- `controller.spec.ts`:
  - `base-unlisted keeps strong without judging`;
  - `removing a held pool candidate ends the streak`;
  - `ends a held streak with base-unlisted when settings remove its route from routeFrom`.

### 3.4 Bug 4: a candidate failure fails the whole turn

**Change.** No loop change is needed: this uses the existing `agent/request-error` waterfall (`runtime-types.ts:292`, `agent.ts:371-386`).

The router registers `ctx.on('agent/request-error', listener)` through `ctx.effect` with a disposer, only while a router is composed. The listener:
1. calls `next()` **first**, so llm-retry keeps ownership of transient retries (`llm-retry/src/index.ts:156-208`). If `next()` returns `{kind:'retry'}`, the listener returns it unchanged. This makes the behaviour independent of listener order.
2. converts the failure only if downstream returns `undefined`, the failed request's `provider` matches the pinned downgraded selection for this `turn`/`step`, `config.inTurnFallback === 'manual'`, and the failure code is not `ABORTED`. It then:
   - appends a decision `{outcome:'kept-strong', reason:'route-failed', failure:{code, provider, model}, sticky:{active:false, brokenBy:'route-failed', entryBase}}`;
   - replaces the pin with that strong decision;
   - returns `{kind:'retry'}`.
3. relies on the loop's `continue`, which re-enters `buildRequest` and so runs the `agent/request` waterfall again. `resolveRequest` sees the non-downgraded pin for this turn and returns `undefined`, so the manual route is used. The decision precedes the retried request's header, so the pre-publication invariant holds.
4. leaves the failed attempt's `assistant/chunk` error chunk in the log; the `route-failed` decision records its `failedChunkSeq`.

**Breaker counting moves from `turn/end` to decisions.** `folds.ts:114-121,328-335` counts consecutive `route-failed` decisions per held candidate across streaks, not only while a streak is active. Reaching `maxRouteErrors` sets `needsStrongTurn`, and `route-errors` recovery keeps its current semantics.

**Config.**
- `inTurnFallback: 'manual' | 'off'`, default `'manual'`. `off` keeps the current behaviour for a deployment that wants failures visible.
- `maxRouteErrors` keeps its default of 2 and counts `route-failed` decisions.

**Invariant.** A `route-failed` decision must follow a same-turn, same-step downgraded decision with the same provider.

**Tests.**
- `controller.spec.ts`:
  - `candidate stream error retries the same step on the manual route`;
  - `defers to llm-retry when it schedules a retry`;
  - `inTurnFallback off leaves the failure terminal`;
  - `aborted failure is not converted`.
- `folds.spec.ts`: `route-failed decisions count toward maxRouteErrors across streaks`.
- Real-composition `provider-composition.spec.ts`: `a 500 from the candidate completes the turn on the manual model`, with a fake HTTP candidate provider.
- New keyless snapshot `model-router-fallback.cordis.snapshot.yml`.

### 3.5 Bug 5: no hysteresis

**Changes.**
- **Difficulty band.** New `difficulty.entryScoreCeiling`, default `2`: entry requires score < 2, below "involved" on the five-level rubric.
  - `escalateBack.scoreThreshold` stays 3 for exit, so a held streak with 2 ≤ score < 3 stays held.
  - Validation: `entryScoreCeiling <= escalateBack.scoreThreshold`, or load fails by name.
- **Re-entry cooldown.** New `reentryCooldownTurns`, default `2`.
  - After a break by `escalated`, `current-preferred`, `verification-escalated`, or `route-failed`, the next N turns stay strong with reason `reentry-cooldown`, without judgment.
  - The fold derives the cooldown from the break decision's turn, so it is deterministic.
- **Step-counted horizon and cap.** `minTurnsDowngraded` is replaced by:
  - `hold.minSteps` (every-turn policy only), default 20. Evidence: an expired return breaks even at 20.5 steps at 200k with a 5-minute strong TTL.
  - `hold.maxSteps` (both policies), default 40. Evidence: the 5-minute warm window holds at most ~38 steps at 7.8 s per step. This also bounds the hold within the entry turn, where `turnsElapsed` stays 0 (Evidence, unbounded hold).
  - The fold counts steps from `enteredStep`, a new sticky field, using the `(turn, step)` of held decisions.
  - When `hold.maxSteps` is reached, the next consult ends the streak with `brokenBy: 'hold-cap'`.
- **Entry turn.** `turnsElapsed` is replaced by `stepsElapsed`, which advances within the entry turn.

**Logging.** The sticky view adds `enteredStep` and `stepsElapsed`. New reasons: `reentry-cooldown`, and `hold-cap` as a break.

**Tests.**
- `folds.spec.ts`:
  - `stepsElapsed advances within the entry turn`;
  - `hold-cap breaks at maxSteps`;
  - `reentry cooldown derives from the break decision turn`.
- `controller.spec.ts`: `difficulty in [entryCeiling, exitThreshold) holds but does not enter`.
- `config.spec.ts`: `rejects entryScoreCeiling above escalateBack.scoreThreshold`.

### 3.6 Bug 6: judgment failures end streaks, with no deadline or breaker

**Changes.**
- **Deadline.** `judgmentDeadlineMs`, default `1500` (live maximum 924 ms; Laya about 14 ms).
  - The ask receives `AbortSignal.any([signal, AbortSignal.timeout(deadline)])`.
  - A deadline abort that is not a turn abort maps to `engine-unavailable` with `engineFailure: {code:'DEADLINE'}`. A turn abort still propagates.
  - Validation: a positive integer no greater than 30000.
- **Transient tolerance while held.** `judgmentFailures.holdTolerance`, default `2`. While held, up to N consecutive `engine-unavailable` or `invalid-answer` failures keep the held candidate, with reason `judgment-failure-held` (outcome `downgraded`), instead of `keep()` ending the streak (`index.ts:899-920`).
- **Circuit breaker.** `judgmentFailures.breakerThreshold` (default 3 consecutive failures) opens the breaker for `judgmentFailures.breakerOpenTurns` (default 5) turns. Consults in that window log `breaker-open`: kept-strong, no ask. The breaker state is derived from logged decisions, so it is deterministic.
- `state-too-large` and `judgment-input-too-large` remain immediate strong exits, because they are properties of the input, not transient.

**Logging.** A new decision field, `engineFailure?: { code: JudgmentErrorCode | 'DEADLINE' }`.

**Tests** in `controller.spec.ts`:
- `deadline expiry records engine-unavailable DEADLINE and keeps the turn`;
- `held streak survives holdTolerance failures`;
- `breaker opens after breakerThreshold and closes after breakerOpenTurns`;
- `turn abort during the ask still propagates`.

### 3.7 Bug 7: effort changes are hidden cache transitions

**Changes.**
- `candidateSelection` (`index.ts:1100-1116`) applies `difficultyToEffort` **only at streak entry**. There is no `sticky.selectionEffort` field (D-19): effort is durable in each decision's `selection.reasoningEffort` and in the fold's held candidate.
- While a streak is held, the selection is kept if its effort is still reachable: the configured effort or the lift.
- `continuing` (`index.ts:975`) compares the full selection through the fold's exported `sameSelection`. An effort change is then a candidate change, subject to the horizon and the cold-point rules.
- Same-model effort "downgrades" are excluded by `equals-base` (§3.1).

**Tests** in `controller.spec.ts`:
- `difficultyToEffort applies at entry and is frozen for the streak`;
- `an effort change mid-streak is treated as a candidate change`.

### 3.8 Bug 8: compaction summarizes with the routed candidate

**Change** in `packages/compaction/compaction-basic`:
- New config `summarizationRoute: 'request' | 'manual'`, default `'manual'`.
- `summarizer.ts:170-180` resolves the target as `configured ?? (summarizationRoute === 'manual' ? manualRoute(agent) : latest) ?? agentTarget`.
- `manualRoute` reads the optional `ctx.get('modelRouting')?.stickySelection(agent)`, else the latest header.

**Why `manual` is the default.** The summary is durable and model-visible to every later strong turn. Compaction is itself a cold point in the new policy, so the cache advantage of summarizing on the candidate is small next to the quality risk.

**Logging.** Unchanged: the summarizer already records the exact call envelope, including provider and model.

**Tests.**
- `compaction-basic/tests/compaction-basic.spec.ts`:
  - `summarizes on the manual route during a held streak by default`;
  - `summarizationRoute request uses the latest header`.
- A Loader test composing compaction-basic with model-router, in `model-router/tests/composition.spec.ts`.

### 3.9 Bug 9: thinking continuity

**Changes.**
- **Eligibility.** A new eligibility reason, `thinking-mode-incompatible`, applies when the *base* is an Anthropic-API route whose model is not `forceAdaptiveThinking` and whose effort enables budget thinking. A mid-turn return there would silently disable thinking (M5).
  - claude-session ships only adaptive models, so this is dormant there.
  - The fact comes from prepared-call metadata: add `LlmModelInfo.thinkingMode?: 'adaptive' | 'budget' | 'none'`, declared by the pi-ai Anthropic profile compat.
- **Observation, not a new event.** The trajectory and projection derive `returnThinking: 'present' | 'absent'` for the first strong `assistant/message` after a `brokenBy` decision, from its content blocks. This is the documented check.
- **E2E.** `packages/llm/llm-claude-session/tests/foreign-return.e2e.ts` sends a real mid-turn return to Opus 5.5 (a foreign tool_use segment shaped like DeepSeek output). It asserts that the request is accepted and that the reply carries a reasoning block. It runs only with `SHRES_E2E_CLAUDE_FOREIGN_RETURN=1` and a readable Claude login, and self-skips otherwise.
- Document the reasoning-continuity residual under the README's Known Limitations: another model's reasoning becomes plain text.

**Tests.**
- `eligibility.spec.ts`: `excludes routing under a budget-thinking Anthropic base`.
- The trajectory fold spec.

### 3.10 Phase 2 Agent Note

`.agents/notes/implemented/bug-fix/2026-09-24-routing-correctness-after-live-review.md`. It records the live evidence and M1/M2/M3. It cross-links the 2026-09-22 note, which it partially supersedes: the sticky-candidate transitions and the `minTurnsDowngraded` horizon.

## 4. Phase 3: policy redesign

### 4.1 Router config after Phase 3 (`model-router` namespace)

```yaml
initialMode: 'off'            # 'off' | 'shadow' | 'on'
candidates:                   # the one shared pool: id, provider, model, reasoningEffort?, description (required, <= 160 chars)
  - { id: flash, provider: ollama-cloud, model: deepseek-v4.1-flash:cloud, description: "small, well-scoped edits in familiar code" }
routeFrom:                    # required unless initialMode is off; an unlisted base is never routed
  - { provider: claude-session, model: claude-opus-5-5, objective: quota }
operatingPoints:              # per registry engine id; absent engine => engine-uncalibrated (PR 8b)
  - { engine: laya, downgradeThreshold: <set from the §5.7 replay>, downgradeMargin: <set from the §5.7 replay>, calibratedBy: <preregistration id> }
entry:
  policy: cold-points         # 'cold-points' | 'every-turn'
  coldPoints: [session-start, post-compaction, idle, manual-switch, plan-approved]
  unknownTtlMs: 300000
hold: { maxSteps: 40, minSteps: 20, recheckEverySteps: 1 }
difficulty: { entryScoreCeiling: 2 }
escalateBack: { scoreThreshold: 3 }
reentryCooldownTurns: 2
verificationExit: { errorBurst: 3, repeatRunLength: 3, attemptCount: 4, turnFailureStreak: 1 }
planMode: { forceStrong: true }
inTurnFallback: manual
maxRouteErrors: 2
judgmentDeadlineMs: 1500
judgmentFailures: { holdTolerance: 2, breakerThreshold: 3, breakerOpenTurns: 5 }
childPolicies: []             # §4.2
routeInstructions: ...
difficultyInstructions: ...
state: { contextTurns: 2, maxChars: 12000, maxFitCandidates: 8 }
tier: fast
```

`resolveConfig` (`config.ts:230`) validates every field, and `CONFIG_KEYS` grows to match:
- unknown keys fail;
- `plan-approved` in `coldPoints` requires `planMode.forceStrong`;
- `recheckEverySteps >= 1`;
- every `operatingPoints[].engine` must be a registered engine id, checked at the earliest resolvable point (§R1.3);
- `operatingPoints[].calibratedBy` names the preregistration whose replay set the point; an entry without it is uncalibrated.

### 4.2 (a) Subagent and seat routing

**Extension point.** `subagent/child-route` is implemented (PR 13a, #219). `@shres-code/shres-code-subagent` declares the waterfall, and `SubagentRuntime.resolveChildRoute(name, input)` is its only dispatch site, which the delegation consumers call once per fresh child. The [child-route note](../../implemented/architecture/2026-09-24-subagent-child-route.md) records the payload, the cases that skip dispatch, the ordering contract, and why dispatch is not inside `effectiveChildRoute`. `docs/architecture.md` lists the waterfall among the extension points, and `docs/subsystems/subagent.md` owns its types.

**Router listener.** `childPolicies: [{ match: { kind?: 'subagent' | 'workflow', agentType?: string }, candidate: <id>, judge?: boolean }]` (PR 13b) applies only while the parent's manual route is listed in `routeFrom`, and `candidate` must be a pool id.
- `judge: false` (the default) is a static route.
- `judge: true` asks the selected engine a two-option question (`keep-current` or the candidate) about the delegation prompt. That prompt is short, which makes it the best fit for Laya's window.

**Rules.**
- An explicit `requested.provider/model` always wins (manual authority).
- `kind: 'fork'` is never routed.
- Team seats keep their roster bindings (`packages/subagent/agent-seats/src/roster.ts`), so seats are not routed. Seats already select models explicitly, and that is the deployment's lever.

**Logging.** A new `model-routing/child-decision` event in the **parent** log, appended before `ctx.agents.create()`:
- payload: `{ childKind, agentType?, selection?, reason: 'child-policy' | 'child-judged' | 'child-kept' | 'fork-excluded' | 'explicit-request', engine?, model?, latencyMs?, route? }`;
- the child's first `request/header` must match it, which the invariant checks;
- the existing spawn telemetry already logs the route in the parent's model-visible result.

**Failure.** The in-turn fallback (§3.4) applies within the child. The router listener is installed per agent through `installModelSelection` for children too. The in-process driver does not call it for children, so subagents and team seats are never routed (Evidence, defects and gaps). Installing it is part of PR 13b.

**Tests.**
- PR 13a: `packages/subagent/subagent/tests/child-route.spec.ts` covers explicit override, fork exclusion, byte-identical behaviour without a listener, and listener disposal (HMR safety).
- PR 13b:
  - router `child-policy.spec.ts`;
  - a Loader test composing `tool-subagent` with the router;
  - keyless snapshot `model-router-subagent.cordis.snapshot.yml`;
  - `subagent-section.client.spec.tsx` for the card's subagent section (§R1.5).

### 4.3 (b) Plan/execute phase routing

- **Strong gate.** `planMode.forceStrong: true` (default). The consult folds the latest `plan/mode` event. While plan mode is active, the decision is `kept-strong` / `plan-mode` without judgment, and a held streak breaks with `brokenBy: 'plan-mode'`.
- **Execute entry.** When `plan-approved` is in `entry.coldPoints`, one request becomes an entry treated like a cold point, with `coldPoint.kind: 'plan-approved'`: the first request after a `plan/mode {active:false}` that follows an approved `exit_plan_mode` tool result. The judge then asks whether executing the approved plan fits a candidate.
  - This is opt-in, because it is the one entry that leaves a warm strong cache. Its value is the classic split: plan on the strong model, execute on the cheap one, with an expected return to strong for review.
- **Logging.** `coldPoint: {kind:'plan-approved', planModeSeq}`.
- **Tests.**
  - `controller.spec.ts`: `plan mode forces strong and breaks a held streak`; `plan-approved entry fires once after approval`.
  - A Loader test composing `plan-mode` with the router.

### 4.4 (c) Verification-driven escalation

- **Extraction.** Move the pure folds `foldEscalationTriggers`, `foldProgressFacts`, and their helpers from `packages/team/worker-escalation/src/fold.ts` into a new package with no service, `packages/team/progress-signals` (`@shres-code/shres-code-progress-signals`). Both worker-escalation and model-router consume it.
  - The trigger config types move with the folds, and the `EscalationTrigger` names stay.
  - This follows the rules on symmetry and one home per fact: the router must not depend on the Team package.
- **Router use.** While a streak is held, every consult folds the triggers over events after `sticky.enteredSeq`, using the `verificationExit` thresholds.
  - A fired trigger → `kept-strong` / `verification-escalated`, `brokenBy: 'verification-escalated'`, `trigger: <name>`, `triggerSeq`.
  - This check runs **before** the judge, so a failing streak exits without a judge call.
- **At strong entry.** A cold-point entry is refused with `verification-active` when a trigger fired in the last `reentryCooldownTurns` turns.
- **Tests.**
  - The `progress-signals` unit tests move with the code.
  - Router `controller.spec.ts`: `errorBurst after entry escalates before judging`; `repeatRunLength escalates`.
  - The worker-escalation specs stay unchanged as a regression check.

### 4.5 (d) Cold-point switching and (e) objectives

**Cold-point fold.** `folds.ts` adds `coldPointAt(events, base, ttlMs, now)`, which returns `{kind, evidence}` or `undefined`:
- `session-start`: no `request/header` or `assistant/message` exists for this base, **and** the session has no seeded or parent history (`parentSession` absent, no fork seed). Resumed and forked sessions are warm, because caches are per model and per account (Evidence, log statistics).
- `post-compaction`: a compaction commit event follows the last base-route `assistant/message`.
- `idle`: `now - lastBaseRequestStartTime > ttlMs`. The TTL is counted from the request start, as Anthropic counts it. `ttlMs` comes from `LlmModelInfo.promptCacheTtlMs` (§2.1), else `entry.unknownTtlMs`.
- `manual-switch`: the latest `agent/model-selection` changed the base since the last base request.
- `plan-approved`: see §4.3.

**Determinism.** `now` is wall-clock time, so the decision records `coldPoint: { kind, idleMs?, ttlMs?, lastBaseSeq?, compactionSeq? }`. Replay folds the recorded decision and never recomputes `now`, which keeps the rule that everything model-visible is reconstructable from the log.

**Entry and return.**
- Outside a streak and not at a cold point: no judgment and no event, just the manual route. Warm turns therefore pay no judge latency.
- At a cold point, the router judges. Entry requires the judge check, the difficulty ceiling, and no active cooldown.
- A held streak returns to strong at the next cold point, with `brokenBy: 'cold-point-return'`, unless the judge re-affirms at that cold point (the candidate passes the judge check and the streak continues).
- A held streak also returns on the quality exits (§1.2) or at `hold.maxSteps`.

**Objective semantics** (`routeFrom[].objective`, recorded on every decision resolved against that route as `objective`):
- `quota`: the strong route is a subscription or credit plan, and the aim is to move tokens off it.
  - Candidates on flat plans are admissible if listed.
  - Cold-point switching is required: `every-turn` is refused at load for a quota route unless its entry sets `allowEveryTurn: true`, for bench use. Until PR 12 adds cold-point entry, per-turn entry is the only policy, so every quota entry sets it.
- `dollars`: a metered strong route.
  - The deployment chooses the pool, and its Agent Note must cite the price snapshot. The router enforces no prices.
  - `every-turn` is permitted.
- `latency`: a strong route chosen for speed. Admission is the shared pool, as for the other objectives.
  - Judging must fit the deadline, so `judgmentDeadlineMs <= 200` is required. In practice that requires a local engine.

**Tests.**
- `folds.spec.ts`:
  - `idle beyond TTL is a cold point`;
  - `resumed session with parent history is not session-start cold`;
  - `compaction after last base message is cold`;
  - `replay uses the recorded coldPoint, not the clock`.
- `controller.spec.ts`:
  - `warm turn writes no decision`;
  - `cold-point-return ends a streak at the next cold point`.
- `config.spec.ts`:
  - `quota base refuses every-turn without allowEveryTurn`;
  - `latency objective requires deadline <= 200`.
- Keyless snapshots:
  - `model-router-coldpoint.cordis.snapshot.yml`, including an idle gap as a recorded fixture time;
  - `model-router-shadow.cordis.snapshot.yml`.

### 4.6 Shadow mode

- `initialMode: 'shadow'` (also `/route shadow`) runs the same policy and judgment but **never rewrites the request**.
- **Off the critical path.** It appends `model-routing/shadow-decision` (the same payload as a decision, with `ignorable: true`) *after* dispatch.
  - The judgment starts when the request is built, but the waterfall does not await it.
  - The decision is appended once the judgment resolves, or dropped on abort.
- The pre-publication invariant does not apply, because a shadow decision never changes a header.
- **Purpose.** Shadow mode collects offline-replay states and outcomes at zero quality risk.
- **Remote engines.** With TypeSafe, shadow mode means egress and possibly clause (vi) data use. Shadow therefore requires the selected engine's descriptor to declare `egress: 'none'` unless `allowRemoteShadow: true` is set.
- **Tests.**
  - `shadow never changes a request header`;
  - `shadow decision is ignorable and absent in off mode`;
  - `remote engine refuses shadow without allowRemoteShadow`.

### 4.7 Phase 3 Agent Note

`.agents/notes/proposed/feature/2026-09-27-cold-point-routing-and-child-routes.md` moves to `implemented/` on merge. It partially supersedes the per-turn entry and horizon portions of `2026-09-17-jev-judgment-routing-and-compaction.md` and `2026-09-22-routing-choice-and-difficulty.md`, so both stay active and cross-linked.

## R. Judgment engines workstream (R1–R4)

### R1. "Model routing" settings section with a runtime engine switch

#### R1.1 How engines coexist

The design is a **Definition-owned engine registry plus one dispatcher that provides `ctx.judgment`**. The rejected alternative, one mounted provider per composition, gives no runtime switch.

- **Registry.** `packages/llm/judgment` (the Definition) adds `JudgmentEngineRegistry`, a service named `judgmentEngines`:
  - `register(id: JudgmentEngineId, entry: JudgmentEngineEntry): () => void`
  - `list(): readonly JudgmentEngineDescriptor[]`
  - `get(id): JudgmentEngineEntry | undefined`
  - `subscribe(listener): () => void`, for status changes.
- **Types.**
  - `JudgmentEngineId` is branded (`shres-brand`).
  - `JudgmentEngineEntry = { engine: JudgmentEngine; descriptor: JudgmentEngineDescriptor; status(): JudgmentEngineStatus }`.
  - `JudgmentEngineDescriptor = { id; label; egress: 'none' | 'local' | 'remote'; calibration: 'calibrated' | 'logprob' | 'verbalized'; supportsFitting: boolean; host?: 'darwin-arm64' | 'any'; terms?: string }`.
  - `JudgmentEngineStatus = { state: 'ready' | 'starting' | 'unavailable' | 'unconfigured' | 'not-installed' | 'unsupported-host'; detail?: string }`.
- **Providers register engines** instead of implementing `JudgmentService` directly. `judgment-typesafe`, `judgment-shield`, `judgment-laya` (new), and `judgment-llm` (new, R4) each call `ctx.effect(() => ctx.judgmentEngines.register(id, entry))`. Registry ids are `typesafe`, `shield`, `laya`, and `llm:<route>`.
- **Dispatcher.** A new package, `packages/llm/judgment-dispatch` (`@shres-code/shres-code-judgment-dispatch`), is the one `JudgmentService` implementation, mounted as `ctx.judgment`.
  - `ask` resolves the selected id through the settings source, then calls `registry.get(id)`. A missing id throws `JudgmentError('UNCONFIGURED', 'judgment engine "<id>" is not composed')`. A status other than `ready` throws `UNAVAILABLE` with the status detail.
  - `fitting` is a getter returning the selected entry's `engine.fitting`, so the router's `engine.fitting === undefined` branch still works per ask.
  - Each result carries the provider-reported `engine` and `model`. The dispatcher adds `engineId` to `JudgmentResult`, a new optional field in `types.ts:145`.
- **No automatic engine fallback.** Silently answering with another engine would change decisions under a different calibration. When the selected engine fails, the result is `UNAVAILABLE`, and consumers fall back to strong.
- **Consumers** (model-router, worker-escalation, compaction-jev) are unchanged except that they record `engineId`.
- **Compositions.** Under the pre-release stance, every composition that mounts a provider directly adds `judgment-dispatch`:
  - the bench overlays `bench/routing/route-on.patch.yml` and `route-shield.patch.yml`;
  - the `examples/headless-agent/model-router-*.cordis.snapshot.yml` compositions;
  - the demo home.

#### R1.2 Settings namespaces

- **`judgment`** (Definition-owned, `judgment/src/settings.ts`) becomes `{ enabled: boolean; engine: string }`.
  - The composition default for `engine` comes from the `judgment-dispatch` config field `defaultEngine`, which is required. There is no implicit "first registered" engine.
  - `installJudgmentSettings` moves to the dispatcher, because the section exists where the dispatch exists.
  - Per-consumer overrides (`overrides: { 'model-router': 'laya', 'worker-escalation': 'typesafe' }`) are owner decision D7. They add an optional `consumer` id to `JudgmentInput`. Add them in R1, because Laya's window cannot hold the worker-escalation digest (`DEFAULT_MAX_DIGEST_CHARS = 4000`).
- **`model-router`** keeps its ownership. The new section displays it, and `operatingPoints` ties it to engine ids.
- **Classifier card.** `packages/client/ui-settings-models/src/client/ClassifierCard.tsx` (the `judgment.enabled` toggle) moves into the new section, so the fact has one home. The Models section keeps only model selection and links to "Model routing".

#### R1.3 Validation and fail-loud behaviour

| Condition | When detected | Behaviour |
|---|---|---|
| `defaultEngine` names an id no plugin registers | Dispatcher `ready`, after the Loader settles, which is the earliest resolvable point | `ctx.logger.error`; the settings section reports `invalid: engine "<id>" is not composed`; every ask throws `UNCONFIGURED` → router `engine-absent` |
| A settings write selects an unregistered id | Write time: the section validator checks the live registry | The write is rejected with a named error; the UI lists only registered ids |
| A settings write selects an engine whose descriptor `host` does not match (Laya on Linux) | Write time | Rejected: `engine "laya" requires darwin-arm64` |
| The selected engine is registered but not ready | Each ask; status is pushed to the UI | `UNAVAILABLE` → `engine-unavailable`, subject to the §3.6 tolerance and breaker; the UI shows status and detail |
| `operatingPoints` lacks the selected engine | Consult | `kept-strong` / `engine-uncalibrated`, no ask; the UI shows "not calibrated for routing" |
| `operatingPoints[].engine` names an unregistered id | Dispatcher ready | Logged error; the router config reports invalid; decisions fall back as above |

The settings API needs a validator hook if `installSettingsSection` lacks one: add `validate?(value): string | undefined` to the `packages/settings` `installSettingsSection` options.

#### R1.4 Logging

- Router decisions already record `engine`, `model`, and `latencyMs`. Add:
  - `selectedEngine: JudgmentEngineId`, recorded even when the ask failed or was skipped (`engine-uncalibrated`, `breaker-open`);
  - `operatingPoint: {downgradeThreshold, downgradeMargin}`, the values applied, so a later settings change cannot reinterpret history.
- The worker-escalation `escalation/decision` event also records `selectedEngine`.
- Settings changes are not session events. Decisions carry the engine that answered, which is what replay needs.

#### R1.5 UI

- **Server exposure.** The registry list and status are exposed through the existing Typert RPC gateway as a `judgmentEngines` host API: `list` plus a status subscription. The `judgment` and `model-router` settings sections use the existing settings RPC.
- **New client plugin package, `packages/client/ui-settings-model-routing`,** following the `ui-settings-*` convention. `ui-model-routing` stays the chat-surface chip, a separate role. The owner edits the pool and `routeFrom` in the card; thresholds stay read-only until they are calibrated (D-46). The "Model routing" section is delivered in three PRs (D-48, D-51):
  - **PR 9a**, after PR 8a:
    - the **mode**: off, shadow, or on, with a note that it matches `/route`;
    - the **engine selector**: registered engines with descriptor badges (local or remote egress, calibrated or uncalibrated), a status dot, and the detail;
    - the `judgment.enabled` toggle, moved from the Classifier card;
    - an Install button for Laya when its status is `not-installed` (§R2.4).
  - **PR 9b**, after PRs 7, 8a, and 9a:
    - the **pool editor**: add a model from the llm model list the Models editor uses; an editable id slugged from the model; an effort select from the model's declared efforts; the description, with guidance at 120 characters and a hard stop at 160; remove;
    - **route from**: one toggle per configured strong model, each requiring an objective with no preselection;
    - a **read-only view** of `downgradeThreshold` and `downgradeMargin` per engine, with an "Uncalibrated" badge for any operating point without `calibratedBy`, plus the hysteresis values and `hold.*`;
    - the cross-membership and always-ineligible warnings (§3.3), computed by a new `modelRouting.poolStatus()` Typert host API that reports, per pool entry and listed route, registration, declared context, modalities, efforts, and the eligibility floor with `equals-base` flagged.
    - The whole section saves in one settings write; the server `validate` hook runs, a rejection shows the named message beside the offending row, and nothing is published until the write commits.
  - **PR 13b**: the subagent section, shown only when the router's config schema has `childPolicies`. It lists "match (kind or agent type) → pool id" rules with an optional judge toggle, offers only pool ids, and states that fork children are never routed.
- **Tests.**
  - `tests/model-routing-section.client.spec.tsx` (9a): it renders engines and status; selecting an engine writes `judgment.engine`; unregistered ids are not offered; a rejected write shows the named error.
  - 9b: `pool-editor.client.spec.tsx` (add from the runtime list, editable slug, description counter and hard stop, remove, both warnings); `route-from.client.spec.tsx` (a toggle requires an objective; the named server error appears on its row); `thresholds.client.spec.tsx` (the uncalibrated badge).
  - `tests/browser-plugin.client.spec.ts`: slot-registration disposal (HMR safety); the host `poolStatus` registration is disposed with its fiber.
  - A real-composition Loader test (the web-app composition with TypeSafe plus a fake shield engine registered): a settings write switches `selectedEngine` on the next decision (9a); a write adding a pool model routes to it on the next decision, a write removing it ends a held streak with `unknown-candidate`, and a write naming an unregistered provider is rejected by name with the pool unchanged (9b).
  - PRs 9a, 9b, and 13b each include a GIF recorded against the real server (`record-browser-gif` skill).

### R2. Laya running locally inside shres-code

#### R2.1 Packaging

The design is **a new provider package that owns a supervised sidecar**. judgment-shield stays a pure wire client with no supervision, as its contract requires.

- **`packages/llm/judgment-laya`** (`@shres-code/shres-code-judgment-laya`) is a Node plugin that:
  1. resolves and validates config;
  2. supervises the Python gateway through `ctx.subprocess` (`packages/subprocess`);
  3. registers engine id `laya`, using a wire client **exported by judgment-shield**. Add `createShieldWireEngine({ endpoint, models, timeoutMs, maxRequestBytes, maxResponseBytes })` to `judgment-shield`, factored from its service so there is one wire implementation.
- **`python/laya-gateway`** (distribution `shres-laya-gateway`, module `laya_gateway`) holds a `pyproject.toml`, a `uv.lock` with hashes, and `manifests/<revision>.json` files carrying per-file SHA-256 hashes. It implements the judgment-shield wire:
  - `POST /v1/judgments`;
  - `POST /v1/judgments/fitted`, with tokenizer-exact counts from the loaded model's tokenizer;
  - `GET /healthz`.
  - It replies with `engine: 'shield'`, the exact model id `aac6fef/<repo>@<sha>`, and `latencyMs`.
  - It binds 127.0.0.1 on port 0 and prints one readiness line to stdout, which avoids port races: `{"ready":true,"port":N,"model":"…","manifestSha256":"…","limits":{…}}`.
  - It maps `choice`, `score`, and `binary` questions onto `agent.predict(state, {id:{type: choice|score|noul, …}})`.

#### R2.2 Config (`judgment-laya`)

| Field | Default | Validation |
|---|---|---|
| `enabled` | `true` | boolean |
| `model.repo` | required | non-empty; pinned |
| `model.revision` | required (40-character sha) | `/^[0-9a-f]{40}$/`. Resolved full revisions: `aac6fef/laya-mlx` `20aed815fc6acde75733882e7ec0e3f28aeb9717` (512 tokens), `aac6fef/laya-multilingual-mlx` `f2b4faf51023039425946074e2cf1361d2db11d5` (1,024), `aac6fef/laya-typed-decisions-mlx` `f9e501c2080cc57c13d6887820329758f5351125` (1,024; first candidate) |
| `model.manifestSha256` | required | must equal the gateway's reported manifest, else `INVALID_ANSWER` and status `unavailable: manifest mismatch` |
| `checkpointContext` | required: `512 \| 1024` | must equal the gateway's reported `maxSequenceTokens` |
| `runtimeDir` | `<SHRES_HOME>/runtimes/laya-gateway` | absolute after resolve; created with mode 0700 |
| `hfHome` | `<runtimeDir>/hf` | same |
| `python` | `uv`-managed (`uvPath` default: `uv` on PATH) | fails with `not-installed` if uv is absent |
| `startupTimeoutMs` | `120000` (first model load) | positive, ≤ 600000 |
| `requestTimeoutMs` | `2000` | positive; the router's `judgmentDeadlineMs` should exceed it (documented) |
| `shutdownGraceMs` | `5000` | positive |
| `restart.maxRestarts` / `restart.windowMs` / `restart.backoffMs` | `5` / `600000` / `1000`, doubling up to 30000 | positive integers |
| `autoInstall` | `false` | boolean; installing is always an explicit action |

#### R2.3 Lifecycle (per `docs/defensive-patterns.md`)

- **Registration first, as status.** On apply, register the `laya` entry with status `starting`, or `not-installed` / `unsupported-host`. The engine's `ask` throws `UNAVAILABLE` until the status is `ready`. The descriptor is published immediately, so the UI and the settings validator can name it.
- **Start** inside `ctx.effect`:
  1. host check: `process.platform === 'darwin' && process.arch === 'arm64'`, else `unsupported-host` and no spawn;
  2. install check: the venv marker file records the `uv.lock` hash and the manifest verification;
  3. spawn `<venv>/bin/python -m laya_gateway --host 127.0.0.1 --port 0 --repo … --revision … --checkpoint-context …` with a **scrubbed environment**:
     - drop `*KEY*`, `*SECRET*`, `*TOKEN*`, and `*PASSWORD*`;
     - set `HF_HOME`, `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, and `PYTHONNOUSERSITE=1`;
  4. read the readiness line within `startupTimeoutMs`, then `GET /healthz`, then a smoke ask; then set the status to `ready`. State is published only at this commit point.
- **Independent outcomes.** The supervisor records `exitCode`, `signal`, `timedOut`, and `stderrTail` (bounded to 8 KiB) as separate facts.
- **Crash and restart.**
  - The status becomes `unavailable` *before* the restart is scheduled, so in-flight asks fail with `UNAVAILABLE` and the router falls back.
  - Restarts use exponential backoff within the `restart.*` limits.
  - Once `maxRestarts` is exceeded within `windowMs`, the status stays `unavailable` with the detail until settings are re-applied or the Install/Restart UI action runs.
- **Disposal reaches quiescence:**
  1. unregister the engine and close status subscriptions first, so late completions stay silent;
  2. abort in-flight HTTP requests;
  3. send SIGTERM and **await** exit for up to `shutdownGraceMs`;
  4. then send SIGKILL and await `done`.
  - The disposer is async, and the Cordis fiber waits on it.
- **Callback containment.** Status-listener exceptions are caught and logged inside the registry's dispatch loop.
- **Tests** (`packages/llm/judgment-laya/tests/`):
  - `supervisor.spec.ts`, with a fake gateway script:
    - `publishes ready only after readiness line, healthz and smoke ask`;
    - `crash flips status to unavailable before restart`;
    - `restart budget exhausts to unavailable`;
    - `dispose unregisters then awaits child exit`;
    - `env is scrubbed of credential-shaped variables`;
    - `manifest mismatch is unavailable`;
    - `unsupported host never spawns`.
  - The HMR disposal test.
  - E2E `judgment-laya/tests/laya.e2e.ts`: real laya-mlx; self-skips unless the host is darwin-arm64 **and** Laya is installed.

#### R2.4 Install path and offline behaviour

- **Explicit install action** (owner decision D8): the `/judgment install laya` command, and the Install button calling the same host method, `judgmentLaya.install()`. It:
  1. runs `uv venv --python 3.11` into `runtimeDir/venv` (3.11 is the laya-mlx minimum and is present on this Mac), then `uv sync --frozen --project python/laya-gateway` with `UV_PROJECT_ENVIRONMENT=runtimeDir/venv`;
  2. downloads the weights with `huggingface_hub.snapshot_download(repo, revision=<pinned sha>, local_dir=hfHome/…)` and `HF_HUB_OFFLINE=0`, **only** during install;
  3. verifies each file's SHA-256 against `manifests/<revision>.json`. On a mismatch it deletes the download, a known real directory, and fails;
  4. writes a marker with the lock hash, the revision, and the manifest hash.
- **The runtime is always offline** (`HF_HUB_OFFLINE=1`). Missing weights give `not-installed`, never a download at startup. With no network after install, everything still works.
- **Supply chain.** The MLX weights are a third-party conversion (`aac6fef/*-mlx`), not the convaiinnovations artifact. The conversions (2026-09-19) also predate the upstream weight updates (2026-09-23). Before pinning, PR 10 must:
  - read each conversion's source revision from laya-mlx's `benchmarks/results/hub-publication.json`;
  - re-run laya-mlx's 63-question fidelity check locally against PyTorch Laya at the matching upstream revision, and record the result in the Agent Note;
  - prefer converting from the pinned convaiinnovations revision ourselves if laya-mlx ships a converter, and publish only a manifest, not re-hosted weights.
- **Pin reconciliation.** Two artifacts coexist and are recorded separately:
  - the PyTorch shield bench-arm pin `convaiinnovations/laya@1c5edc17a7acd8701df6fc341c0d179f1c62c982`, unchanged;
  - the MLX runtime pin. The first candidate is `aac6fef/laya-typed-decisions-mlx@f9e501c2080cc57c13d6887820329758f5351125` (1,024 tokens). The alternatives are `aac6fef/laya-multilingual-mlx@f2b4faf51023039425946074e2cf1361d2db11d5` (1,024) and `aac6fef/laya-mlx@20aed815fc6acde75733882e7ec0e3f28aeb9717` (512). The fidelity check and the §5.7 replay decide the pin.
  - The Hugging Face head `aa8c91ca088ec597df95a0d1c76b3063cb2ae5e8` is **not** adopted until the §5 evaluation reruns on it. A pin bump is its own PR, with fresh replay scores.

#### R2.5 Context limits vs the router's state fitting

- The context limit covers instructions, options, and state. The route question, with `keep-current` plus N candidate descriptions, consumes `maxHeadTokens`.
- At 512 tokens with 2–3 options and short descriptions, the state gets roughly 250–350 tokens (about 1–1.4k characters), usually only the current user message.
  - The router's fitting already supplies ordered alternatives down to "current entry only".
  - An oversized input gives `judgment-input-too-large` and the strong route, which fails safe.
- **Consequences and required changes.**
  - Use a 1,024-token checkpoint. The first candidate is `laya-typed-decisions-mlx`, and `laya-multilingual-mlx` is the alternative (§R2.2). The local fidelity check and the §5.7 replay decide the pin.
  - **Load-time head check.** Once `laya` is ready, the router asks `fitting` with an empty state and its real questions. If the head alone exceeds `maxHeadTokens`, it logs an error, and decisions record `judgment-input-too-large` with `reason: 'head'`. This fails loud at the earliest resolvable point.
  - Keep `candidates[].description` to 12 words or fewer in Laya deployments, documented in the README.
  - Laya fits the cold-point and child-route questions best. The delegation prompt, or the first message after compaction or an idle gap, is short and self-contained. Mid-streak re-checks rely more on the deterministic (c) signals.
  - Measure the **truncation rate**, the fraction of consults where only the current entry fit, in §5.

#### R2.6 Non-Apple hosts

- On a non-Apple host, `judgment-laya` registers with status `unsupported-host` and never spawns, and a settings selection of `laya` is rejected by name.
- Fallbacks, in order:
  1. a PyTorch Laya gateway run by the deployment behind judgment-shield: the existing bench path, engine id `shield`;
  2. TypeSafe (`typesafe`);
  3. no engine. Routing then happens only through static `childPolicies` with `judge: false`, and cold-point entry is refused with `engine-absent`.
- A supervised PyTorch or CPU gateway variant is deferred to a follow-up; upstream has laptop-CPU benchmarks (#188). It needs the same wire and supervisor, parameterized by runtime.

#### R2.7 Attribution

- `THIRD_PARTY_NOTICES.md` entries, each with its license text reference and upstream URL:
  - laya-mlx (mizorewww, Apache-2.0);
  - Laya (NandhaKishorM, Apache-2.0), for its API and semantics;
  - the Laya weights (convaiinnovations/laya, Apache-2.0);
  - the MLX conversions (aac6fef, Apache-2.0);
  - MLX (Apple, MIT);
  - huggingface_hub (Apache-2.0).
- Include any upstream `NOTICE` file content verbatim, as Apache-2.0 §4(d) requires.
- Extend the `verify-third-party-notices` check (`scripts/gen-third-party-notices.ts --check`) to assert that every top-level dependency in `python/laya-gateway/uv.lock` has a notices entry.

### R3. Upstream tracking

**Recommendation: depend on the upstream PyPI releases, pinned exactly with hashes in `uv.lock`.**
- **The laya-mlx pin is `laya-mlx==0.2.0`.** That is the package's own version. It was published 28 minutes after the "Sync with upstream v0.3.5" commit `0a859518`, the upstream head; "v0.3.5" names the upstream Laya release the port tracks. PR 10 confirms that the 0.2.0 sdist matches `0a859518`.
- **Do not depend on the forks.** They carry no commits of their own, so they add nothing but staleness.
- **Forks as patch staging.** Keep the forks fast-forwarded and use them only to stage patches: a fix we need goes to the fork branch and is PR'd upstream. We consume it through a git-sha pin in `uv.lock` only until the next PyPI release carries it.
- If laya-mlx is not on PyPI at a needed version, pin `git+https://github.com/mizorewww/laya-mlx@<sha>`, the upstream rather than the fork.
- **Fork state on 2026-09-24.**
  - `parthmstech/laya-mlx` is identical to upstream.
  - `parthmstech/laya` was re-synced at 04:23Z to `1a099d9785` (release 0.3.16) and fell one commit behind when upstream released 0.3.17 at 04:24Z.
  - Because upstream releases this often, the drift report below is the tracking signal, not fork parity.

**Tracking.**
- `scripts/check-laya-upstream.ts` (`pnpm run check:laya-upstream`) compares these against the pins, prints a drift report, and exits 0:
  - the latest PyPI version of `laya-mlx`;
  - the Hugging Face heads of the pinned repositories;
  - the GitHub upstream tags.
- It runs as a scheduled GitHub workflow once Actions are re-enabled (owner decision D5); until then it runs by hand.
- Each bump PR must carry fresh §5.7 offline-replay scores and the fidelity check.
- **Upstream fixes not yet in MLX.** laya-mlx tracks Laya v0.3.5, so upstream fixes from v0.3.6 through 0.3.17 are not in the MLX runtime, including:
  - the calibration hold-out slice;
  - ECE counting zero confidence;
  - calibrated confidence reported alongside the existing confidence;
  - hardened inference and runtime parity.
- Watch upstream's "routing-task calibration" work (#188), because it may change the operating points.

### R4. "Any third-party" engine

**What it covers.**
1. **An LLM route used as a judge.** A new package, `packages/llm/judgment-llm`, with engine id `llm:<provider>/<model>`.
   - It asks a registered `ctx.llm` route with a structured-output JSON schema: one probability per option for choice questions, a distribution over levels for scores, and p(yes) for binary questions.
   - Where the adapter exposes token logprobs (OpenAI-compatible `top_logprobs`), options are single-token labels and probabilities come from logprobs (`calibration: 'logprob'`). Otherwise probabilities are the model's own stated numbers (`calibration: 'verbalized'`).
   - Config: `provider`, `model`, `reasoningEffort?`, `maxStateTokens`, `timeoutMs`, `temperature?`. Opus rejects `temperature`, so validate against model compat and fail at load.
2. **A hosted classifier API speaking the judgment-shield wire remotely.** `judgment-shield` gains `endpointPolicy: 'loopback' | 'remote'`, default `loopback` (the current rule). `remote` requires a `credentialRef` and marks the descriptor `egress: 'remote'`. Descriptors carry a `terms` URL.
3. **Other vendors.** A new provider package implementing `JudgmentEngine` and registering into `judgmentEngines`.

**Provider contract** (added to the `JudgmentEngine` JSDoc and `docs/subsystems/judgment.md`):
- a probability for **every** requested option, as the TypeSafe rule requires; an omitted option is `INVALID_ANSWER`;
- `confidence` defined as the engine's documented concentration measure;
- the exact `model` identity and `latencyMs`;
- honour `signal`;
- consult the `JudgmentRedactor` exactly once per state;
- declare `egress`, `calibration`, and `supportsFitting` truthfully;
- never retry beyond its own documented policy.

**Calibration caveats.**
- Verbalized LLM probabilities are not calibrated, and thresholds from one engine do not transfer to another. That is why operating points are per engine (§R1.4), and an engine without one is `engine-uncalibrated`.
- Policy: `verbalized` engines may be selected for shadow and bench runs only. The router refuses to decide downgrades on them unless an `operatingPoints[]` entry sets `acceptVerbalized: true` (owner decision D9).
- An LLM judge's own tokens count against its route's quota or dollars, and the §5.1 accounting includes them.
- An LLM judge on the *same* provider as the strong route competes for its quota and rate limits.

## 5. Phase 4: measurement before default-on

The bench work lands in separate PRs into the Jev branch (D-60).

### 5.1 Bench cost accounting

- **Priced and cache-inclusive.** In `bench/runner/metrics.js` and `descendants.js:149-163`, `foldUsage` sums the new `TokenUsage` fields:
  - input, output, and the cache read and write counts, read through `cacheCount(usage, 'read' | 'write')`. There is no write-TTL class;
  - unreported calls are flagged and excluded from cache-share metrics. They are counted at the uncached input price in a separately reported upper bound.
- **Price snapshot.** `bench/prices/2026-09-24.json` is a dated snapshot per model: input, output, 5-minute write, 1-hour write, read, and the peak/off-peak windows. Every trial records `priceSnapshot`, and off-peak windows apply by request timestamp.
  - The runtime still has no prices. The snapshot is research-only, consistent with the "tokens are the only runtime cost currency" note, which the bench Agent Note amends for bench scope.
- **Per-arm report:**
  - priced dollars (API-equivalent);
  - **strong-route quota tokens**: tokens billed to subscription or credit routes, weighted to input-equivalent;
  - raw tokens by class.
- **Judge calls.** Fold `model-routing/decision`, `child-decision`, and `shadow-decision`:
  - count calls, sum `latencyMs`, and record the judge engine and model;
  - LLM judges' usage is priced;
  - TypeSafe is priced per the vendor plan if known; otherwise it is reported as a call count.
- **TTFT and latency.**
  - Per step, TTFT = the first `assistant/chunk` time − the `request/header` time.
  - Report the added critical-path latency: the sum of judgment `latencyMs` on awaited consults plus eligibility time. Add `eligibilityMs` to decisions; it measures the eligibility time that step 1 of every turn pays (Evidence, step-1 latency on every turn).
  - Per-trial `durationMs` is kept.
- **Tokenizer asymmetry.** Report dollars, and never claim token equality across vendors.

### 5.2 Task suite

- **`bench/tasks/routing-multiturn/`**: 60 new multi-turn tasks of 3–8 user turns each, with scripted follow-ups. Each has a deterministic verifier (tests pass, or a file-diff predicate) and an independent difficulty label:
  - 20 trivial or routine;
  - 20 moderate;
  - 20 hard (cross-cutting, unfamiliar code).
- **Real idle gaps.** The runner replays inter-turn wall-clock gaps sampled from the logged distribution: 29.4% of gaps exceed 300 s and 5.7% exceed 3,600 s (start-to-start). Sampling is stratified so each task has at least one gap over 300 s.
  - To bound bench time, gaps are real sleeps only on the confirmatory run.
  - The exploratory run uses a **TTL-emulation flag** that forces a cold strong request (`cacheRetention: none` for that request) at gap points. This is documented as an approximation.
- **Delegation-heavy tasks.** Include at least 15 tasks that naturally spawn subagents, so (a) is measurable.
- **Difficulty must discriminate.** In a calibration run (always-strong vs always-cheap, 1 repeat), keep only tasks where the arms differ for at least 30% of the hard stratum and at most 10% of the routine stratum. Otherwise the suite is at ceiling, as the pilots were.

### 5.3 Arms and baselines

| Arm | Definition |
|---|---|
| `always-strong` | Opus 5.5 (1-hour TTL once verified), no router |
| `always-strong-5m` | The same with a 5-minute TTL; isolates the TTL effect from routing |
| `always-cheap` | DeepSeek V4.1 Flash throughout |
| `static-tier` | Strong main model, and every subagent on Flash (`childPolicies` static, no judge) |
| `cascade` | Flash first; escalate to strong on a verification trigger (c), with no judge |
| `router-coldpoint` | The full Phase 3 policy with the engine under test: Laya; TypeSafe only with terms clearance (owner decision D3) |
| `router-everyturn` | Legacy per-turn entry (`entry.policy: every-turn`), same engine |
| `random-matched` | Enters at the same cold points as `router-coldpoint`, with probability equal to its realized downgrade rate, from a seeded RNG logged per decision |
| `oracle` | Per task, the cheapest arm among {always-cheap, static-tier, always-strong} that passed, computed post hoc. It is a loose bound for step-level routing, and is reported as such. |

### 5.4 Sample size and pre-specified operating point

- **Primary endpoint.** Task success of `router-coldpoint` vs `always-strong`, paired by task, with a non-inferiority margin of δ = 5 points, one-sided α = 0.025, and power 0.8.
  - With expected discordance of 10–20%, this needs **314–628 pairs** (n = 7.85·p_disc/δ², where p_disc is the share of tasks on which the arms disagree).
  - Plan: 60 tasks × 6 repeats = 360 pairs.
  - Report within-task variance per arm (cluster-robust, with the ICC-adjusted design effect). Add repeats if the observed discordance exceeds 18%.
- **Secondary endpoints**, Holm-corrected:
  - strong-quota reduction (paired log-ratio, d = −ln 0.8; 40–158 pairs suffice);
  - `router-coldpoint` beats `random-matched` on success at the matched rate;
  - added p95 turn latency.
- **One pre-specified operating point.** It is fixed *before* the confirmatory run, from the offline replay (§5.7): the threshold/margin pair maximizing coverage, subject to a replay false-downgrade rate of 10% or less. It is recorded in `bench/routing/prereg-2026-10.md` with a registration JSON.
  - No operating point is selected post hoc.
  - Exploratory points are reported as exploratory.

### 5.5 Temperature mismatch and cross-arm cache sharing

- **Temperature.** Opus rejects `temperature`, so no arm sets it and all arms run at provider defaults. Determinism comes from repeats, not temperature 0. The preregistration states this, and within-task variance is reported per arm.
- **Cache isolation.**
  - Randomize arm order per task, with a seeded order that is logged.
  - Use a separate Anthropic organization or API key per strong-using arm where possible; caches are isolated per organization.
  - Report the first request's cache reads (`cacheCount(usage, 'read')`) per trial, and exclude or flag trials whose first request hit a warm cache they did not create.
  - DeepSeek and Ollama caches persist for hours to days, so inject a per-arm nonce in the first user message: a logged, model-visible task header in a fixed format. This decorrelates prefixes across arms for all providers.
  - Tag Anthropic 20-block lookback misses separately, and do not attribute them to routing.
- **Metered keys.** The confirmatory strong arms run on metered API keys, not subscriptions, both for volume and for dollar comparability.

### 5.6 Budget

- **Per task-run estimate** at about 25 steps and about 150k average context:
  - always-strong: about $1.60 at a warm 5-minute TTL, plus cold events;
  - cheap arms: about $0.05–0.20.
- **Confirmatory run** (360 pairs × about 4 arms that use the strong model × about $1.6–2.5): **about $2.5–3.6k**.
- **Exploratory calibration run and offline replay:** about $0.5k.
- **Total request: a $4k cap with a hard stop** (owner decision D12). The runner already supports `--max-total-tokens`; add a `--max-dollars` cap that uses the price snapshot.
- Laya has no marginal cost. The TypeSafe arm's cost depends on the vendor plan.

### 5.7 Offline judge-replay scoring

- **Dataset.** Every cold-point state from the `always-strong` and `always-cheap` runs, rendered by the router's own renderer (`conversation-v1` plus per-engine fitting).
- **Label.** "Cheap sufficient" means the always-cheap arm passed the task **and** its step-level trajectory from that cold point reached the next cold point without a verification trigger.
- `bench/routing/replay-judges.mjs` runs each engine (Laya-512, Laya-1024, TypeSafe with clearance, `llm:<route>`) on identical states and reports:
  - AUROC;
  - ECE;
  - coverage vs false-downgrade curves;
  - the **truncation rate** (only the current entry fit);
  - per-question head tokens.
- **Laya evaluation criteria.** The artifact stays a development baseline until all of these hold:
  - AUROC ≥ 0.70;
  - at the chosen operating point, a false-downgrade rate ≤ 10% with coverage ≥ 15% of cold points;
  - ECE ≤ 0.10; otherwise thresholds are set from the replay rather than read as probabilities;
  - if TypeSafe is measured, no worse than TypeSafe by more than 0.05 AUROC.
  - On failure, Laya stays shadow-only, and `operatingPoints` has no `laya` entry.
- The replay reuses `bench/routing/outcome-dataset.mjs` to assemble labels.

### 5.8 Exact criteria for turning routing on by default

Routing's `initialMode` may become `on` in a shipped composition (the web-app or headless bundle defaults, or a recommended settings profile) only when **all** of the following hold on the confirmatory run:

1. **Quality.** The lower 97.5% bound of (router − always-strong) task success is above −5 points, both overall **and** in the hard stratum.
2. **Signal.** Router success exceeds random-matched success at the matched rate, Holm-adjusted p < 0.05.
3. **Value.** Strong-route quota tokens fall by at least 20% vs always-strong, and dollars fall by at least 20% for dollars-objective bases, each with a 95% CI excluding 0.
4. **Latency.** Added p95 critical-path latency per turn is at most 50 ms, and no warm turn pays a judge call.
5. **Robustness.** Zero user turns are lost to candidate failures, and every injected candidate 5xx in fault-injection trials completes via `route-failed`. There are zero invariant failures.
6. **Cache.** Strong cold-write tokens per session do not increase vs `always-strong` at the same TTL.
7. **Engine eligibility.** The default engine passed §5.7, has `egress: none`, and its licence permits product use.
8. **Docs and notes.** The Agent Note records the preregistration, the results, and the chosen operating point, and the README's operating-point prose cites them.

Until then, the default is `off`, and `shadow` is permitted with a local engine.

## 6. Delivery sequence

Every PR in this plan targets and merges into `feat/jev-judgment-foundation` (the Jev branch, #195's head), where the owner tests and verifies routing. Nothing merges to master, which is reached only through draft #195 once the owner is satisfied (D-60). Stacks on the Jev branch use GitHub native stacks (the `shres-merging-stacked-prs` skill), and a PR fixes a defect it introduces before the defect propagates. The Status column records each PR's state on the Jev branch; #204, #207, and #216 are numbers `gh stack link` printed for native stacks, not PRs (D-59). The delivery amendments below the table record the decisions that changed scope and order.

| # | Title | Status | Packages | Depends on | Agent Note | Key tests |
|---|---|---|---|---|---|---|
| 0 | Catalog classification fix (#202): `Request` and `Response` on `ctx.clientModules.fetchBundle`, plus `ctx.cursorCredential` ported byte-identical from #195 | closed unmerged: its classification is already on the Jev branch | `scripts/gen-cordis-catalog.ts`, regenerated catalogs | — | existing | `verify-cordis-catalog`, `verify-doc-graphs` |
| 0b | Restore doc-sync: the remaining 9 gates (#203, branch `fix/master-doc-sync`) | merged as `995eec0447` | the files named by the failing gates | — | — | `pnpm run doc-sync` passes 26 of 26; a prerequisite for re-enabling CI (D5) |
| 0c | `llm-pi-ai` unit tests against the installed pi-ai 0.84.1 catalog (#211, D-32) | merged as `13328e9b69` | llm-pi-ai | — | — | llm-pi-ai 281 of 281 |
| 0d | Web snapshots for the Claude subscription provider rows (#217) | merged as `3c87c82f21` | web goldens (test-only) | — | — | the web snapshot lane replays 19 of 19 |
| 1 | `llm-claude-session: explicit cacheRetention and promptCacheTtlMs` (#210) | merged as `1561af98a1` | llm-claude-session, llm (`LlmModelInfo.promptCacheTtlMs`) | — | `implemented/feature/2026-09-24-claude-session-cache-retention.md` (records the OAuth 1-hour probe result once the owner runs it; pending, D-25) | config.spec cases in §2.1; the opt-in `.e2e.ts` cache-TTL probe (D-24, D-25); no GIF, because the Web GUI does not render the field (D-31) |
| 2 | `llm: three-state cache usage telemetry` (#214) | merged as `16045771ea` | llm (`cacheCount`), llm-pi-ai (`cacheUsage`), llm-deepseek, other adapters, token-meter, compaction-basic readers, `bench/runner/metrics.js` | 0b | `implemented/architecture/2026-09-24-three-state-cache-usage.md` | the D-22 behaviours (pi-ai reported zero and unreported omission, `cacheCount` returning `undefined` for absence, token-meter "not reported", bench `cacheHitShare`); stream/translate specs; session-adapter and invariant coverage; token-meter specs; keyless snapshot re-record |
| 3 | `system-prompt: section stability classes and prefix-stability check` (#205) | merged as `29b9756bfc` | core/system-prompt | — | `implemented/architecture/2026-09-24-stable-prompt-prefix.md` (the requirement; the doctrine-section migration is owned elsewhere) | `prefix-stability.spec.ts` |
| 4 | `model-router: equals-base eligibility, frozen effort, base-name guard` (bugs 1, 7, 2; #206) | landed through #212's merge `853b4129ab` | model-router, bundle/headless, bundle/web-app, the `apps/cli` agent presets, router-composing example compositions | — | `implemented/bug-fix/2026-09-24-routing-correctness-after-live-review.md` (created here; extended by PRs 5–7) | §3.1, §3.2, §3.7; snapshot re-records. The persona change (D10) is a separable commit. |
| 5 | `model-router: in-turn fallback via agent/request-error` (bug 4; #212) | merged as `853b4129ab` | model-router | 4 | same note | §3.4; `model-router-fallback` snapshot |
| 6 | `model-router: hysteresis, step horizon, judgment deadline/tolerance/breaker` (bugs 5, 6; #220) | merged as `6b83872393` | model-router | 5 | same note | §3.5, §3.6 |
| 7 | `model-router: shared pool and routeFrom with per-route objective; compaction summarizes on the manual route; thinking-mode eligibility` (bugs 3, 8, 9; (e); branch `fix/model-router-routefrom-compaction-thinking`) | not merged | model-router, compaction-basic, compaction-jev, llm (`thinkingMode`), llm-pi-ai, ui-trajectory, ui-model-routing, llm-claude-session e2e, bench overlays, router compositions | 6 | same note | §3.3, §3.8, §3.9; the opt-in `foreign-return` e2e |
| — | **#195 doc-gate cleanup** (commits `2b9bbfd58c`, `c8ef75b2fb`, `cee6f55279`): fix only the doc-gate failures #195 introduces relative to master, on #195 itself (D-11) | on the Jev branch | the files named by the branch-introduced failures | — | — | no doc-gate failure beyond master's baseline |
| — | **#195 → master.** The consolidated Jev branch reaches master only through #195, a draft, once the owner has verified routing on it (D-60). The router ships in no default bundle; the demo home follows owner decision D1. | draft | | | | pre-push checks per the `shres-pre-push-checks` skill |
| 8a | `judgment: engine registry and dispatcher` (R1 backend; D-39; #222) | merged as `d787c5fce8` | judgment, judgment-dispatch (new), judgment-typesafe, judgment-shield (`endpointPolicy`), judgment-laya (migrated into the registry), worker-escalation (`selectedEngine`), settings (`validate` hook), bench overlays, examples | 10a | `implemented/architecture/2026-09-24-judgment-engine-registry.md`; partially supersedes the 2026-09-20 shipped note's single-engine facts | registry disposal (HMR); dispatcher `UNCONFIGURED`/`UNAVAILABLE`; settings write rejection; Loader test switching engines |
| 8b | `model-router: per-engine operating points` (D-39, D-48) | not merged | model-router (`operatingPoints` with `calibratedBy`, `engine-uncalibrated`, `selectedEngine` and `operatingPoint` on decisions) | 7, 8a | extends the 8a note | an engine without an operating point keeps strong as `engine-uncalibrated` |
| 9a | `ui-settings-model-routing: mode, engine selector, enabled toggle, engine status` (R1 UI; D-48) | not merged | client/ui-settings-model-routing (new), ui-settings-models (Classifier card removed), api Typert gateway (`judgmentEngines` host API) | 8a | same as PR 8a (UI section) | 9a specs in §R1.5; browser-plugin disposal; GIF |
| 9b | `ui-settings-model-routing: pool editor, route from, read-only thresholds` (D-46, D-48) | not merged | client/ui-settings-model-routing, api Typert gateway (`modelRouting.poolStatus()`), model-router (the write-time unregistered-provider check, §3.3) | 7, 8a, 9a | same as PR 8a (UI section) | 9b specs in §R1.5; Loader pool-edit test; GIF |
| 10a | `judgment-laya: supervised local MLX gateway` as a `ctx.judgment` provider (R2, R3; D-9; #213) | merged as `a583c1c692` | judgment-laya (new), `python/laya-gateway` (new), judgment-shield (wire client export), `THIRD_PARTY_NOTICES.md`, `scripts/gen-third-party-notices.ts` (notices check), `scripts/check-laya-upstream.ts` | — | `implemented/feature/2026-09-24-local-laya-judgment.md` (pins, fidelity-check result, install and offline policy, upstream-tracking policy) | supervisor specs in §R2.3; e2e `laya.e2e.ts`; notices check |
| 11 | `progress-signals: extract escalation folds` (#209) | merged as `4f4b9802c1` | team/progress-signals (new), worker-escalation | — | `implemented/architecture/2026-09-24-progress-signals-extraction.md` | moved unit tests; worker-escalation regression |
| 12 | `model-router: cold-point entry, verification exits, plan-mode gate, shadow mode` ((b), (c), (d)) | not merged | model-router, plan-mode (read-only fold consumer), ui-trajectory (cold-point and shadow rows) | 1, 2, 7, 8b, 11 | a new proposed note for cold-point routing, moved to implemented when the PR lands; partially supersedes the 2026-09-17 proposal and the 2026-09-22 note | §4.3–4.6; `model-router-coldpoint` and `model-router-shadow` snapshots |
| 13a | `subagent: child-route waterfall` ((a); D-51; #219) | merged as `fce43521e7` | subagent/subagent, tool-subagent, `docs/architecture.md` (extension-point list), `docs/subsystems/subagent.md` | — | `implemented/architecture/2026-09-24-subagent-child-route.md` | `child-route.spec.ts`; behaviour without a listener is byte-identical |
| 13b | `model-router: child policies; card subagent section` ((a); D-51) | not merged | model-router (`childPolicies`, `model-routing/child-decision`, `installModelSelection` for children), client/ui-settings-model-routing | 9b, 12 | the PR 12 note | §4.2; `model-router-subagent` snapshot; GIF |
| 14 | `judgment-llm: LLM-as-judge engine` (R4; branch `feat/judgment-llm`) | not merged | judgment-llm (new) | 8a | `implemented/feature/2026-09-24-llm-judgment-engine.md` (calibration caveats) | structured-output parse; logprob path; verbalized flag; config rejects temperature on Opus |
| 15a | Research price snapshot for the bench (§5.1; D-20, D-23, D-30; #208) | merged as `7c542532fc` | bench/prices | — | — | prices tests 8/8; doc-sync 26/26; a required `nullFields` array keeps every missing price explicit |
| 15 | `bench: priced cache-inclusive accounting, judge calls, TTFT, dollar cap` (#218) | merged as `db65f2bb72` | bench/runner, bench/prices | 15a | `implemented/process/2026-09-24-bench-priced-accounting.md` | accounting unit tests over fixture trials |
| 16 | `bench: multi-turn routing suite with idle gaps, arms, offline judge replay, preregistration` | not merged | `bench/tasks/routing-multiturn`, `bench/routing/replay-judges.mjs`, `runner/arms.js`, preregistration | 12, 13b, 15 | a new process note for the routing measurement gate | runner dry-run; replay on fixture states |
| 17 | `routing: default-on decision` (only if §5.8 passes) | not merged | bundle defaults or recommended profile, model-router README | PR 16 results | a new decision note citing the results | snapshot of the default composition |

**Dependency order.**
- The routing chain continues 7 → 9a → 9b → 13b, with 8b after PR 7 (D-48); PR 8a is merged.
- PRs 9a and 14 need only PR 8a. PR 12 needs PRs 7, 8b, and 11. PR 16 needs PRs 12, 13b, and 15.
- The Laya install on this Mac (owner decision D8) unblocks the PR 10a e2e.

**Delivery amendments.** Decisions made during delivery, numbered D-0 onward in the delivery log, amend this sequence. This list is the durable record of those that change the plan. Provenance: the local research archive in `.run/routing-review-evidence/2026-09-24/` and `~/shres-research/routing-review-2026-09-24.tar.zst`, which is not in git.

- **D-0 PR 0 scope.** origin/master had four catalog violations, not two, because `ctx.cursorCredential` was never classified there.
  - PR 0 ports the cursor-credential classification from #195 byte-identical (commit `91b8a940a4`), so the later #195 merge does not conflict on it.
  - It ports #195's `LINK_MAP` classification rather than adding `TYPE_LINK_EXEMPTIONS` entries, which would collide with #195's `LINK_MAP` at merge.
  - Master doc-sync moves from 15 to 17 of 26 gates with no regression.
- **D-1 PR 0b.** PR 0b restores the remaining 9 master doc-sync gates. It is stacked on PR 0 and is a prerequisite for re-enabling CI (owner decision D5).
- **D-2 #195 doc-gate cleanup.** Branch-introduced doc-gate failures are fixed on #195 itself, following the repository rule to fix the introducing PR. #195 failed 12 of 26 gates against master's 11; the extra gate was doc refs.
- **D-3 PR 11 base.** `packages/team/worker-escalation` exists only on #195, so PR 11 is a #195-stack PR, independent of PRs 4–7. PR 12 already depends on PR 11 and the #195 stack. PRs 1, 2, 3, and 15 touch only packages that exist on master.
- **D-4 Acceptance bar.** No delivery PR may add a doc-gate failure relative to the doc-sync baselines recorded under Evidence.
- **D-5 Plan of record.** This design is the plan of record. After the #195 stack, the local-engine chain runs before PRs 12, 13, and 14; D-9 amends its order. The Laya pins are those resolved in Evidence and §R2.2.
- **D-6 Master-based PRs stack on PR 0b.** PRs 1, 2, and 3 are rebased onto `fix/master-doc-sync` before they open.
  - This gives their doc gates a clean 26/26 baseline.
  - It avoids re-syncing the `LlmModelInfo` type-equiv paste in `docs/subsystems/llm-streaming.md`, which PR 0b already fixes.
- **D-7 PR 0 opened as #202** (`fix/catalog-request-response` at `91b8a940a4`). Merging #195 after PR 0 lands produces four additive conflicts, resolved by union plus regeneration.
- **D-8 PR 0b opened as #203** (`fix/master-doc-sync`). It brings master doc-sync to 26 of 26. #202 → #203 form GitHub native stack #204.
- **D-9 PR 10a ahead of PR 8.** The owner's top priority is a local judge with no Jev egress, and PR 8 waits on the #195 merge, which waits on owner decision D5.
  - PR 10a stacks on #195 (branch `feat/judgment-laya-local`) and ships `judgment-laya` as a standalone `ctx.judgment` provider: the supervised MLX gateway, the shared shield wire client, the pins, and the fidelity check.
  - PR 10a carries the §R2 scope, so references to PR 10 in this note mean PR 10a.
  - PR 8 later migrates the provider into the engine registry with a small change. The end-state design is unchanged.
- **D-10 Plan commits and fork tracking.** This note's commits are `511fc36fe3` (documentation fixes) and `45ff3c807f` (the note).
  - `parthmstech/laya-mlx` is identical to upstream.
  - `parthmstech/laya` was re-synced after upstream's release 0.3.12, at 04:23Z to `1a099d9785` (release 0.3.16). Upstream released 0.3.17 at 04:24Z, leaving the fork one commit behind at 04:38Z.
  - Upstream releases several times an hour, so the drift report (§R3), not fork parity, is the tracking signal.
- **D-11 #195 cleanup scope.** The cleanup fixes only violations the branch introduces relative to master.
  - It also adds `Request` and `Response` classification lines identical to PR 0's. The catalog generator then works for the #195 stack PRs, and the #204 merge-forward stays conflict-free for that hunk.
  - Violations shared with master arrive through the merge-forward after #204 lands.
- **D-12, D-13 PR 3 final and open.** PR 3 is `adb866aa45`, a single commit on #203 with real generator output and doc-sync at 26 of 26.
  - It opened as #205 (`feat/system-prompt-prefix-stability`), based on `fix/master-doc-sync` (#203), as an independent sibling of PR 1. Its planned retarget to master is superseded by D-60: #205 merged into the Jev branch.
  - Disabling the check fails exactly 5 rule tests.
  - Its implementation establishes the §2.3 correction: ordering conditional sections last protects only tools and static sections, and `ctx.systemPrompt.context()` is the cache-safe home for toggling text.
- **D-14 PR 11 committed** as `2860a17910` on the #195 stack.
  - progress-signals passes 46 of 46 tests and worker-escalation 126 of 126, both at 100% coverage.
  - PR 11 is rebased onto #195 after the cleanup, so the catalog gate can run.
  - Follow-ups for PR 12: model-router consumes progress-signals, reuses its durable-failure check, and imports the argument-canonicalization duplicate from repeat-tool-reminder.
- **D-15 Jev egress stopped.** A hot reload of the demo home's `initialMode: off` recorded `model-routing/configuration {active:false}` at 13:16:05. The last TypeSafe consult was at 13:11:52, making 22 in total, all kept-strong.
- **D-16 #195 siblings.** PRs 4–7 form the official stack on #195. PRs 10a and 11 are siblings on #195 with base `feat/jev-judgment-foundation`, because GitHub stacks are linear. Their planned retarget to master is superseded by D-60: both merged into the Jev branch.
- **D-17 #195 cleanup done.** Commits `2b9bbfd58c`, `c8ef75b2fb`, and `cee6f55279` take #195 doc-sync from 14/12 to 17/9, and all 9 remaining failures are in master's baseline.
  - The regenerated catalog artifacts stay, because the #195 stack PRs need a working generator.
  - The four additive conflicts with #204 resolve by union plus regeneration.
- **D-18 PR 2 started early.** PR 2 runs on base `fix/master-doc-sync` (PR 0b), branch `feat/three-state-cache-usage`, in parallel with PR 1.
  - The two overlap only in the `llm` types and `docs/subsystems/llm-streaming.md`, which are resolved at rebase.
  - PR 2 is on the critical path for PRs 12 and 15.
  - Its worker lists every #195-branch reader of `cacheReadTokens` that must migrate at merge-forward.
- **D-19 PR 4 committed** as `8eeb7a72a1`, `4c6b985cc0`, and `13e4ab5d60`. 223 of 223 tests pass at 100% coverage.
  - The persona commit is separable, pending owner decision D10.
  - The accepted deviations are carried into §3.1, §3.2, and §3.7: `candidate-equals-base` keeps a narrower meaning, there is no `selectionEffort` field, and bug 2 covers the CLI agent presets and the 9 router snapshot configurations.
  - PR 5, the in-turn fallback, is on branch `fix/model-router-in-turn-fallback`, stacked on `13e4ab5d60`.
- **D-20, D-23 PR 15a.** PR 15a is a research price snapshot for the bench, stacked on PR 0b and squashed as `235f507966`.
  - Its prices tests pass 8 of 8, and doc-sync passes 26 of 26.
  - A required `nullFields` array keeps every missing price explicit.
  - DeepSeek V4 Pro, verified against the official DeepSeek page and the Ollama page, which agree: peak input $1.32, cache read $0.044, and output $3.96 per million tokens; off-peak is half.
  - The DeepSeek API retired the legacy name `deepseek-v4-flash` and bills it at V4.1 Flash prices.
- **D-21 PR 2 paused for a design ruling.** §2.2's required `cache` union would crash consumers on existing logs with a TypeError, because the loader does not validate payloads, instead of rejecting them. It would also churn 426 fixture usage objects and create 5 conflicts in #195 bench files.
- **D-22 Aegis ruling on PR 2.** Option B, with conditions, supersedes the tagged union. §2.2 records the design: presence as the signal, per-profile `cacheUsage`, the `cacheCount` helper, the restated invariant, TTFT documented in `llm-streaming.md`, `writeTtl` dropped, and the old-log limitation. Alternatives considered records why A, A1, and A2 were rejected.
- **D-24 PR 1 committed** as `7777da807a`, based on origin/master. It adds `cacheRetention`, `promptCacheTtlMs` through a route-owner hook, and the `INVALID_MODEL_CACHE_TTL` error code.
  - Accepted deviation: the probe is named `.e2e.ts`, so it stays out of `pnpm test`, and it runs only with `SHRES_E2E_CLAUDE_CACHE_TTL=1`.
  - PR 1 is rebased onto `fix/master-doc-sync` (D-6) with a regenerated API catalog (D-31).
- **D-25 Live 1-hour TTL probe held for owner approval.** The §2.1.1 probe uses the claude-session OAuth credential that a live session shares, so an OAuth refresh could disrupt that session. It runs only with the owner's go-ahead, ideally when no critical session is using the credential.
- **D-26 Review order.** plan note → #195 cleanup → PR 4 → PR 11 → PR 15a (`235f507966`) → PR 1 (after its rebase).
- **D-27 #195 pushes and new PRs.**
  - The #195 plan note (`45ff3c807f`) and cleanup (`cee6f55279`) are pushed.
  - PR 4 is open as #206, linked as native stack #207 (#195 → #206), with its review fix in `f552403863`. Its negative controls fail as intended, and the §3.2 guard raises no false positives, because instructions are user messages.
  - PR 15a is open as #208, based on #203.
- **D-28 PR 1 Settings GIF (superseded by D-31).** The GIF rule was applied on the assumption that the Settings form renders the claude-session `cacheRetention` field from its schema. The GIF is recorded on a separate server started from the PR 1 worktree, with a temporary `SHRES_HOME` and a free port. It touches neither the live server nor the user installation, and uses no credentials.
- **D-29 PR 11 opened as #209.** PR 11 is rebased onto origin `cee6f55279` with an identical range-diff, and the module-graph, cordis, and config catalogs pass. Its head is `e605f2b413`, open on base `feat/jev-judgment-foundation` as a sibling of stack #207.
- **D-30 PR 15a README.** `40e0a3ceb1` states that an empty `offPeakWindowsUtc` next to non-empty peak windows means no off-peak rate is published. The prices tests pass 8 of 8.
- **D-31 PR 1 rebased; no GIF.** PR 1 is `9bb8941cdc`, a single commit on `fix/master-doc-sync`, with doc-sync at 26 of 26. The Models settings editor is hand-written per adapter family and maps `llm-claude-session` to its `unknown` layout, which shows only the `settings.yaml` hint. The Web GUI therefore does not render `cacheRetention`, and the GIF rule does not apply.
- **D-32 PR 0c: master unit tests.** Master fails 3 `llm-pi-ai` unit tests against the installed pi-ai 0.84.1 DeepSeek catalog. These failures predate this plan. A root-cause fix on a branch based on PR 0b makes master's unit tests green, a prerequisite for re-enabling CI (D5).
- **D-39 PR 8 split.** PR 8a covers the judgment engine registry, `judgment-dispatch` (the single `ctx.judgment`, with a required `defaultEngine` and no engine fallback), the `judgment` settings `{ enabled, engine, overrides }` with a `validate` hook, and the typesafe, shield, and laya migrations. PR 8b, after PR 7, makes model-router consume `operatingPoints` and record `selectedEngine` and `operatingPoint`. PR 9 needs only 8a, and deferring the router part avoids conflicts with PRs 6 and 7, which rewrite the router config.
- **D-46 Editable shared pool (owner decision).** The Settings "Model routing" card edits the model pool in v1, and thresholds stay read-only until they are calibrated. One shared pool serves every strong model, replacing per-base candidate lists, and the subagent pool (`childPolicies`) lives in the same card. Routing runs only from the strong models the owner enables, and `equals-base` candidates stay excluded. The owner accepts that a pool candidate can be a lateral or upward move for some routes.
- **D-48 Shared-pool design.** `candidates` is the one shared pool, with required descriptions of at most 160 characters, and `routeFrom` is a fail-closed allowlist of strong routes with a required objective on each entry (§3.3, §4.1, §4.5). It supersedes `basePolicies` with its per-base candidate lists and base-lists-itself load error, which `equals-base` covers. PR 9 splits into 9a and 9b (§R1.5), and PR 13b adds the card's subagent section. `operatingPoints[].calibratedBy` and `engine-uncalibrated` belong to PR 8b, where operating points arrive.
- **D-51 PR 13 split.** PR 13a is the generic `subagent/child-route` waterfall with no router code; without a listener, delegation is byte-identical. PR 13b adds the router's `childPolicies`, `installModelSelection` for children, the `model-routing/child-decision` event, and the card's subagent section, after PR 9b.
- **D-60 Consolidation branch (owner rule).** Every model-routing PR, including routing improvements, the cache prerequisites, and the bench work, targets and merges into `feat/jev-judgment-foundation` for the owner to test and verify. Nothing merges to master. Master is reached through #195, now a draft, once the owner is satisfied. This rule supersedes the master bases and master retargeting in D-6, D-12, D-16, and D-18: those PRs merged into the Jev branch (§6).

## 7. Owner decisions

Each entry gives the recommendation, followed by the resolution.

- **D1. Routing in the demo home meanwhile.**
  - *Recommendation:* turn routing off now (`initialMode: off`, or remove the mount). Live, it added 704 ms to every turn with 0 downgrades and sent up to 12k characters per turn to TypeSafe. After PR 10, switch to `shadow` with Laya for data collection. Do not run shadow with TypeSafe (egress and clause (vi)).
  - *Resolution:* **adopted.** Routing is off in the demo home, and moves to shadow mode with Laya after PR 10.
- **D2. Objective per route.**
  - *Recommendation:* claude-session Opus 5.5 → `quota` (subscription); codex-session and grok-session → `quota`; a zai GLM-5.3 base → `latency`, or unlisted (plan credits, near-peer candidates); any metered API-key route → `dollars`. The bench reports all three regardless.
  - *Resolution:* **adopted.**
- **D3. TypeSafe dependence vs local Laya.**
  - *Recommendation:*
    - make Laya the routing engine candidate: no egress, about 7–14 ms, Apache-2.0;
    - keep TypeSafe only for consumers that need a larger context (worker-escalation), through the per-consumer override;
    - request written clarification from TypeSafe on clause (vi) before using its answers in bench, offline replay, or shadow data. Until then, measure TypeSafe only on its routing verdict in live use, not as training or development data.
    - Laya still has to pass §5.7.
  - *Resolution:* **owner decided local-first.**
    - Laya is the default routing engine, and no conversation data goes to Jev/TypeSafe.
    - TypeSafe stays selectable for other users.
    - Written clarification of TypeSafe clause (vi) is pending with the owner.
    - In the owner's deployment this excludes TypeSafe for every consumer, including the worker-escalation override in the recommendation. The override mechanism (D7) stays available to other deployments.
- **D4. Candidate set per strong model.**
  - *Recommendation:*
    - Opus 5.5 → `flash` (DeepSeek V4.1 Flash), optionally plus `mid-deepseek-pro` under the quota objective;
    - **remove Kimi K3 and GLM-5.3** from Opus's set: Kimi's warm step costs more than Opus 5.5's at API prices, and GLM costs about the same, so both are lateral or upward moves;
    - GLM-5.3 base → `flash` only, or unlisted;
    - gpt-6-astra and grok bases → unlisted until measured;
    - subagents: `flash` for explore and search types (`childPolicies`).
  - *Resolution:* **adopted.**
- **D5. Re-enable GitHub Actions** at the repository and workflow level.
  - *Recommendation:* yes, before merging the #195 stack. PR 0b, which restores master doc-sync to 26 of 26, is a prerequisite.
    - Enable CI (typecheck, lint, `test:coverage`, doc-sync, hygiene, snapshots) as a required check.
    - Keep real-API e2e manual or secret-gated.
    - Add the scheduled `check:laya-upstream` drift job.
    - The stacked-PR skill requires GitHub to own stack-wide checks.
  - *Resolution:* **pending owner.**
- **D6. 1-hour TTL on the claude-session main route.**
  - *Recommendation:* `cacheRetention: long` once the §2.1.1 probe passes. How subscription quota counts cache writes is unverified; revisit if quota burn rises.
  - *Resolution:* **adopted**, conditional on the §2.1.1 probe.
- **D7. Engine selection scope (R1).**
  - *Recommendation:* a deployment-wide `judgment.engine` plus per-consumer `overrides` in v1, because Laya's window cannot serve worker-escalation's 4k-character digest.
  - *Resolution:* **adopted.**
- **D8. Installing Laya on this Mac, and the checkpoint (R2).**
  - *Recommendation:*
    - install through the explicit install action once PR 10 lands, not by hand;
    - make the typed-decisions MLX checkpoint, `aac6fef/laya-typed-decisions-mlx@f9e501c2080cc57c13d6887820329758f5351125` (1,024 tokens), the first candidate. The local fidelity check and the §5.7 replay decide the pin. The 512-token `aac6fef/laya-mlx` needs the head-token check;
    - before pinning any `aac6fef` conversion, check its source revision in `hub-publication.json` and re-run the local fidelity check;
    - keep auto-install off.
  - *Resolution:* **adopted.**
- **D9. Uncalibrated third-party engines (R4).**
  - *Recommendation:* selectable for shadow and bench runs only. Deciding downgrades requires `operatingPoints[].acceptVerbalized: true` plus a §5.7 replay.
  - *Resolution:* **adopted.**
- **D10. Persona line without the model name (bug 2).**
  - *Recommendation:* remove `{{model}}` from the shipped persona. It is the only fix that needs no loop change, and it stabilizes the prefix.
  - *Resolution:* **pending owner.** PR 4 implements it as a separable commit.
- **D11. Upstream dependency (R3).**
  - *Recommendation:* depend on PyPI releases pinned with hashes; fast-forward the forks and use them only as patch staging.
  - *Resolution:* **adopted.** Both forks were brought level with upstream on 2026-09-24.
    - `parthmstech/laya-mlx` is identical to upstream.
    - `parthmstech/laya` was re-synced after upstream's release 0.3.12, at 04:23Z to `1a099d9785` (release 0.3.16).
    - Upstream released 0.3.17 at 04:24Z, one minute later, so at 04:38Z that fork is one commit behind. Fast-forward it again right before any patch-staging use.
- **D12. Bench budget.**
  - *Recommendation:* approve a $4k hard cap for the Phase 4 confirmatory and exploratory runs, on metered keys, with a separate Anthropic organization or key per strong arm.
  - *Resolution:* **pending owner.**

## Identifier reference

- **Router reasons.**
  - Eligibility: `equals-base`, `thinking-mode-incompatible`.
  - Decision: `base-unlisted`, `engine-uncalibrated`, `route-failed`, `reentry-cooldown`, `judgment-failure-held`, `breaker-open`, `plan-mode`, `verification-escalated`, `verification-active`.
  - Break (`brokenBy`): `hold-cap`, `cold-point-return`, `plan-mode`, `route-failed`, `verification-escalated`.
- **Decision fields.** `coldPoint`, `objective`, `selectedEngine`, `operatingPoint`, `engineFailure`, `failure`, `failedChunkSeq`, `trigger`, `triggerSeq`, `eligibilityMs`; sticky fields `enteredStep`, `stepsElapsed`, `enteredSeq`; the fold exports `sameSelection`.
- **Events.** `model-routing/child-decision`; `model-routing/shadow-decision` (`ignorable: true`).
- **Waterfall.** `subagent/child-route`.
- **Services.** `judgmentEngines` (the registry); `judgment` is provided by `judgment-dispatch`.
- **Settings.** `judgment: { enabled, engine, overrides? }`.
- **Types and helpers.** `cacheCount(usage, 'read' | 'write')` in `llm`; the pi-ai profile field `cacheUsage`; `LlmModelInfo.promptCacheTtlMs`, `LlmModelInfo.thinkingMode`, `JudgmentResult.engineId`.
- **Packages.** `judgment-dispatch`, `judgment-laya` (with `python/laya-gateway`), `judgment-llm`, `progress-signals`, `ui-settings-model-routing`.

## Alternatives considered

**Keeping per-turn judged entry as the default.** Rejected. Live, it made 0 downgrades in 17 consults, and it adds a median 704 ms before every turn's first request. Per-turn entry cannot reach long, hard turns, and quality binds at a failure rate of about 0.33. It survives as the `every-turn` bench arm so the claim stays falsifiable.

**Main-conversation routing as the primary lever.** Rejected in favour of subagent routing (a) and cold points (d). Children have isolated, cold contexts, so routing them costs no parent cache, needs no judge when static, and fits Laya's window.

**A cost-based dwell, from realized savings or a runtime price table.** Rejected. The repository keeps realized tokens as the only runtime cost currency, because prices and rate ratios go stale. The decisive levers are the 1-hour strong TTL and three-state telemetry, not a cost-based horizon (Evidence, verified economics: baseline expiries and the 1-hour TTL). Cold-point switching removes the strong-side transition cost without any prices.

**A required tagged union for cache usage (option A), made safe by an upgrader shim (A1) or loader payload validation (A2).** Rejected by the aegis ruling on PR 2 (D-21, D-22).
- The loader validates event types, not payloads, so a required union crashes existing logs with a TypeError deep in projections instead of rejecting them.
- The union would also churn 426 fixture usage objects and create 5 conflicts in #195 bench files.
- A1 and A2 were the two ways to make the union safe on existing logs, and the ruling rejected both along with A.
- Presence on the existing optional fields (§2.2) carries the same three states without changing the event format.

**Soft-blocking candidates on their observed cache-hit ratio.** Rejected until three-state telemetry exists. pi-ai omits zero cache reads, and the field is absent in 67.7–97.4% of Ollama records, so the ratio would block healthy candidates.

**Gating mid-turn returns to Claude by deferring the return or forcing thinking off.** Rejected. Adaptive-thinking routes degrade gracefully and the API does not error. Budget-thinking bases are excluded by eligibility instead (§3.9), and the remaining continuity loss is documented and observed through `returnThinking`.

**Deciding the route before prompt assembly, or rewriting the system prompt per routed request.** Rejected. The first needs an agent-loop change, because assembly runs once per turn and routing is decided per step. The second violates the rule that `agent/request` listeners change only the config. Removing `{{model}}` plus the invariant guard fixes bug 2 without either.

**One mounted judgment provider per composition.** Rejected: it gives no runtime engine switch, which the owner requires for other users.

**Automatic fallback to another judgment engine.** Rejected. Answers from a different calibration would change decisions silently, and a fallback from a local engine to a remote one would silently send conversation data off the machine. The selected engine failing means `UNAVAILABLE`, and routing falls back to the strong model.

**judgment-shield supervising the Laya runtime.** Rejected. Its contract keeps it a pure wire client. Supervision lives in `judgment-laya`, which reuses the wire client judgment-shield exports, so there is one wire implementation.

**Upstream PyTorch Laya instead of laya-mlx on Apple Silicon.** Rejected for this host. laya-mlx answers in about 7–14 ms without PyTorch, using under 1 GiB of memory. Upstream Laya remains the non-Apple fallback (§R2.6) and the only toolchain for fine-tuning and calibration.

**Depending on the parthmstech forks.** Rejected. The forks carry no commits of their own, so they add only staleness. They serve as patch staging, and dependencies pin upstream PyPI releases or upstream git shas.

**Routing team seats and fork children.** Rejected. Seats are explicit roster bindings (manual authority), and fork children inherit a warm parent prefix that a model switch would forfeit.

**Summarizing compaction on the routed candidate by default.** Rejected. The summary is durable and model-visible to every later strong turn, and compaction is itself a cold point, so the candidate's cache advantage is small. `summarizationRoute: request` keeps the option.

**Changing the `cacheRetention` code default to `long` immediately.** Rejected until the §2.1.1 probe verifies that subscription OAuth honours the 1-hour TTL. The default resolves explicitly to `short`, and deployments opt in.

**A TTFT field on usage events.** Rejected: TTFT is derivable from the logged `request/header` and first `assistant/chunk` times.

**Shadow data collection with a remote engine.** Rejected unless `allowRemoteShadow: true` is set, because it means egress and, for TypeSafe, clause (vi) data use.

**Letting verbalized LLM judges decide downgrades by default.** Rejected. Verbalized probabilities are uncalibrated, so such engines serve shadow and bench runs only unless `acceptVerbalized: true` is set and a §5.7 replay is recorded.

## Acceptance criteria

- **Phase 1.**
  - PR 1's `config.spec.ts` cases pass. The §2.1.1 probe result is recorded with its date, and D6 is resolved from it.
  - PR 2 makes presence the documented signal. Every adapter emits a reported zero and never an unreported count, and every consumer reads through `cacheCount`, so no reader sees a zero where a count was unreported.
  - PR 3's `prefix-stability.spec.ts` rejects a conditional section ordered before a static one.
- **Phase 2.**
  - The tests named in §3.1–§3.9 pass on the #195 stack.
  - The re-recorded keyless snapshots show no routed request naming the manual model.
  - A candidate 5xx completes the turn on the manual model.
  - `docs/architecture.md` and the router README match the shipped behaviour, and the §3.10 note exists.
- **R1.**
  - A settings write switches `selectedEngine` on the next decision in a real-composition Loader test.
  - Writes naming unregistered or host-incompatible engines are rejected by name.
  - No automatic engine fallback exists.
  - The "Model routing" section renders engines and status, recorded as a GIF against the real server.
- **R2.**
  - On darwin-arm64 with Laya installed, `judgment-laya/tests/laya.e2e.ts` passes, and `ready` is published only after the readiness line, `/healthz`, and a smoke ask.
  - The runtime runs offline.
  - The supervisor specs prove scrubbed environments and quiescent disposal.
  - The chosen pin is recorded with its `hub-publication.json` source revision and the local fidelity-check result, and the notices check covers every `uv.lock` top-level dependency.
- **R3 and R4.**
  - `check:laya-upstream` reports drift against the recorded pins.
  - `judgment-llm` declares its calibration truthfully and rejects `temperature` on Opus at load.
- **Phase 3.** The §4.2–§4.6 tests and the snapshots pass, including:
  - `model-router-coldpoint`, `model-router-shadow`, and `model-router-subagent`;
  - a warm turn writes no decision;
  - replay uses the recorded `coldPoint`.
- **Phase 4.**
  - The §5.7 Laya evaluation criteria either pass, giving Laya an operating point, or fail, leaving it shadow-only.
  - Routing becomes default-on only when every §5.8 criterion holds.
- **Documentation.** Each PR lands its Agent Note from §6 and cross-links this proposal, and this proposal's shipped portions are recorded present-tense in those notes.
- **Documentation gates.** No delivery PR adds a doc-gate failure relative to the doc-sync baselines recorded under Evidence. PR 0b (#203) brings the Jev branch to all 26 doc-sync gates, and every later PR keeps it there.
- **Owner decisions.** D3's clause (vi) clarification precedes any use of TypeSafe answers as bench, replay, or shadow data. D5, D10, and D12 are resolved before the PRs that depend on them merge.

## Risks

- **Laya's context window.** At 512 tokens the state is often only the current user message, and at 1,024 it is still a small fraction of the TypeSafe window. Routing quality from so little text is unmeasured.
- **Laya accuracy is unknown.** The artifact is a development baseline, and 63/63 port fidelity is not routing accuracy. If §5.7 fails, local routing stays shadow-only and the owner's local-first deployment has no judged routing, only static child routes.
- **MLX runs only on Apple Silicon.** Other hosts need the deployment-run PyTorch gateway, TypeSafe, or no judge. The supervised PyTorch variant is deferred.
- **Upstream drift.** laya-mlx tracks Laya v0.3.5 while upstream is at 0.3.17, and upstream releases several times an hour. The MLX conversions predate the upstream weight updates, so PR 10 re-checks their provenance and fidelity before pinning. The conversions are third-party artifacts, so supply-chain trust rests on the manifests and the local fidelity check.
- **Subscription behaviour is unverified.** Whether subscription OAuth honours the 1-hour TTL, and how subscription quota counts cache writes and reads, are both unknown. If the TTL is ignored, the cold-point policy assumes 300 s and warm returns stay rare.
- **Hypotheses about candidates.** Kimi thinking mode may reject history without `reasoning_content` (C3), and candidate tool-count limits may reject large tool sets (C8). The in-turn fallback bounds the damage to one extra request, but both need probes before allowlisting.
- **Product-visible persona change (D10).** Removing the model name from the persona changes every shipped prompt and many snapshots. The owner has not yet decided.
- **Old pi-ai logs.** pi-ai logs written before PR 2 omit zero cache reads, so their zeros read as "not reported". The field set is unchanged, so those logs still load.
- **Fewer downgrades by design.** Cold points only give up downgrades inside warm stretches. Plan-mode forcing and manual compaction summaries give up cheap-model savings in exchange for quality.
- **Reasoning continuity.** After any return to Claude, the other model's reasoning reaches it as plain text.
- **Bench cost and fidelity.**
  - The confirmatory run needs about $2.5–3.6k on metered keys (D12).
  - Real idle sleeps make it slow, and the exploratory TTL emulation is an approximation.
  - Temperature cannot be matched across arms, so variance must come from repeats.
  - Time-of-day pricing and tokenizer differences complicate dollar comparisons.
- **TypeSafe terms.** Clause (vi) restricts using the service to develop new products. Until the owner obtains written clarification, TypeSafe cannot supply bench, replay, or shadow data.
- **No CI.** GitHub Actions are disabled, so every gate in this plan runs only locally until D5 is resolved.
