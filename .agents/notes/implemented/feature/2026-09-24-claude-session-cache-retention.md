# Agent Note: Claude subscription route states its prompt-cache retention

Status: implemented

## Problem

The `claude-session` route built its pi-ai profile without `cacheRetention`, so each request's Anthropic cache lifetime was whatever pi-ai 0.84.1 resolves for an absent value: the five-minute ephemeral cache, or the one-hour cache when the process environment happens to carry `PI_CACHE_RETENTION=long`. A deployment could not choose the lifetime per route, and the route's actual behavior depended on an environment variable no configuration surface shows.

The lifetime matters most for interactive coding sessions. One reviewed session on this route lost 847,559 cache-write tokens to three five-minute expiries; every one of those idle gaps was shorter than an hour. Consumers that reason about cache state, such as the planned cold-point routing policy, also had no way to learn a route's lifetime: `LlmModelInfo` carried no cache fact.

## Decision

- **Route setting.** `llm-claude-session` `Config.cacheRetention` accepts `'none'`, `'short'`, or `'long'`. The section schema rejects any other value by field name (`$.cacheRetention expected "none" | "short" | "long" but got …`) at plugin mount and at every settings write. `resolveRoute` always states the retention, defaulting to `DEFAULT_CACHE_RETENTION = 'short'`, so pi-ai's `PI_CACHE_RETENTION` fallback never applies to this route. With the default, the wire stays byte-identical to the unset value under a clean environment.
- **Seam field.** `LlmModelInfo.promptCacheTtlMs` states the prompt-cache lifetime a route requests, in milliseconds from the start of the request that wrote or last read a prefix. `0` means the route writes no cache; absent means unknown. `LlmRuntime` validates it as a non-negative safe integer on both paths: an invalid listing entry fails with `INVALID_CATALOG`, and an invalid exact resolution fails with `INVALID_MODEL_CACHE_TTL`. It passes the value through detached.
- **Owner-declared lifetime.** `PiAiAdapter` accepts a `promptCacheTtlMs(provider, model)` construction hook and copies its answer onto listed and resolved models. It declares nothing without the hook. `claude-session` supplies the hook from `PROMPT_CACHE_TTL_MS`: `none` is 0, `short` is 300000, and `long` is 3600000, which are Anthropic's documented lifetimes. The `llm-pi-ai` plugin supplies no hook, so its routes declare none.
- **Republish on change.** `cacheRetention` is a registration fact. Changing it re-registers the route, which publishes `llm/adapters-updated` so listings refresh their lifetime, and the next request carries the new cache control.

### pi-ai's one-hour gate

pi-ai 0.84.1 decides the TTL in `getCacheControl` (`dist/api/anthropic-messages.js`). The retention is `long` → `{type: 'ephemeral', ttl: '1h'}` when the model's `compat.supportsLongCacheRetention` is not `false`, which is the default; otherwise `{type: 'ephemeral'}`. `none` places no breakpoints. The gate does not read the base URL: a keyless test against a `127.0.0.1` stand-in receives `ttl: '1h'` on every breakpoint. On the OAuth path the breakpoints are the Claude Code identity block, the harness system prompt, the last tool, and the final block of the last user message. Among pi-ai's catalog `anthropic-messages` models, Fireworks' set `supportsLongCacheRetention: false`.

### One-hour cache on the subscription: pending live probe

Whether the subscription OAuth endpoint honours `ttl: '1h'` is unmeasured. The opt-in probe [`cache-retention.e2e.ts`](../../../../packages/llm/llm-claude-session/tests/cache-retention.e2e.ts) runs only with `SHRES_E2E_CLAUDE_CACHE_TTL=1` and a signed-in login. It works as follows:

1. It writes two fresh, uniquely marked prefixes concurrently, one with `long` and one with `short` as the negative control.
2. It asserts from the raw `message_start` usage that each write landed in its asked-for tier. The usage is read through a test-scoped `fetch` tee.
3. It idles six and a half minutes.
4. It asserts that the one-hour prefix is still read and the five-minute prefix has expired.

The default stays `short` until that run passes. Its dated result belongs here: on pass, recommend `long` for interactive deployments; on failure, a 400 or a silent five-minute write, record it as a known limitation, and cold-point policies assume a 300-second lifetime for this route.

## Alternatives considered

**Derive the lifetime inside `PiAiAdapter` from the profile's `cacheRetention` for every `anthropic-messages` route.** Rejected: servers other than Anthropic's speak that wire (Fireworks, MiniMax, Kimi Coding, and the Vercel gateway all appear in pi-ai's catalog), and each keeps prefixes for its own duration. A protocol-derived value would be a false claim for them. Only the route's owner knows its upstream, so the adapter exposes an owner hook, following the existing `resolveApiKey`, `onPayload`, and `onReplayDegrade` hooks.

**Default the route to `long` now.** Rejected until the live probe passes. Long writes cost twice the base input price, against 1.25 times for five-minute writes, and an endpoint that silently ignores the TTL would pay nothing extra but deliver nothing either.

**A standalone `scripts/probe-claude-cache-ttl.ts` calling pi-ai directly for the raw usage split.** Rejected: `@earendil-works/pi-ai` is not resolvable from the repository root or from this package, so the script would need a new dependency or a hand-copied OAuth wire. The e2e probe drives the production route instead and reads the split through a test-scoped `fetch` tee. That works because the Anthropic SDK resolves the global `fetch` when pi-ai builds each request's client.

**Carry the one-hour/five-minute write split in `TokenUsage` now.** Deferred to the three-state cache-usage telemetry change, which owns the `TokenUsage` shape.

## Consequences

- Deployments choose the Claude route's cache lifetime explicitly, and the Settings form shows the field. The process-wide `PI_CACHE_RETENTION=long` no longer lengthens this route's cache; a deployment that relied on it sets `cacheRetention: long`.
- Consumers can read a route's requested lifetime from `listModels` and `resolveModelInfo` without a price or TTL table. The value is what the route asks for; an upstream may retain for less, and only this route declares one today.
- `promptCacheTtlMs` has producers and validation but no consumer yet: `claude-session` declares it through the `PiAiAdapter` hook and `LlmRuntime` validates it on both paths, but no package reads it to make a decision. Its consumer is the cold-point routing policy, PR 12 of the [model-routing redesign plan](../../proposed/feature/2026-09-24-model-routing-redesign-plan.md), which treats an idle gap longer than the strong route's lifetime as a cold point. Until that policy lands, the field changes no behavior.
- The generated Cordis API catalog (`packages/extensions/tool-cordis/src/api-catalog.ts`) carries the field, so `cordis_inspect what:"api"` shows it to the model.
- The live probe costs subscription quota and about seven minutes each run, so it stays opt-in and outside the ordinary e2e run.

Related: the [Claude subscription-session provider](../architecture/2026-09-23-claude-session-provider.md) this extends, and [hosted tools as a route capability](../architecture/2026-09-02-hosted-tools-route-capability.md), the existing route-owned `LlmModelInfo` metadata this follows.
