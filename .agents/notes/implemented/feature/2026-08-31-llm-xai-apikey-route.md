# Agent Note: Pay-per-token xAI API-key Route with Per-Model Service Tier

Status: implemented

## Problem

The LLM seam had no API-key route against xAI's pay-per-token endpoint (https://api.x.ai/v1). The only xAI path was the Grok subscription route (`llm-grok-session`) that drives cli-chat-proxy.grok.com with the CLI's OIDC session credential; there was no way to serve api.x.ai with a user's own key, and no way to opt a request into xAI priority processing, which adds `service_tier: "priority"` to the request body to raise scheduling priority (lower TTFT/ITL) for a different bill.

## Decision

Add an `llm-xai-apikey` provider package beside `llm-grok-session`. It registers one route, `xai-apikey`, serving `openai-responses` against a config-overridable base URL (default `https://api.x.ai/v1`) with every transport/streaming/tool/reasoning/replay concern delegated to the shared `shres-llm-pi-ai` adapter, exactly as `llm-grok-session` does. The package owns only the route config: endpoint, model catalog, per-model service tier, and a credential reference.

The route is **off by default** (`enabled` defaults `false`): it is pay-per-token and needs an explicit key, so nothing serves until a deployment turns it on. It is orthogonal to the subscription route — no `~/.grok/auth.json`, no OIDC, no cli-chat-proxy. When enabled, the key resolves per request through the credentials capability (`ctx.credentials`, the env/.env-backed credential-reference seam) with the trusted launch environment as the fallback when the seam is absent; a key that was never stored fails the first request loud with the repo's established `MISSING_CREDENTIAL` posture.

A per-model `serviceTier` setting (`default` | `priority`) is validated at settings write time. `priority` splices `service_tier: "priority"` into the outgoing request body; `default` omits the field entirely (parity with the Grok CLI, which never sends it). The splice lives in the route's `onPayload` hook on the shared adapter: `PiAiAdapterOptions` gained a minimal additive `onPayload?: (payload, request) => unknown` option so a route can rewrite a provider payload before send. The adapter composes one `onPayload` closure that runs the hosted-search splice first (the sibling grok-hosted-search route's `hostedSearch` option) and then this route's `onPayload`, chaining a non-undefined result from the hosted splice into the route hook and replacing the outgoing payload only on a final non-undefined result. The xAI route uses its hook to map the request's model id to its configured tier and splice the field. The shipped model list (`grok-4.6`, `grok-4.5`, `grok-4.5-mini`, `grok-4.5-vision`) is advisory and config-overridable, matching the sibling route's convention.

The accepted `service_tier` value was extracted from the Grok CLI's generated request types (async-openai `responses.ServiceTier`): `auto` / `default` / `flex` / `scale` / `priority`. The setting exposes only `default` and `priority`: `auto` is server-side project policy, and `flex`/`scale` are a separate pricing track this route does not offer.

## Alternatives considered

- **Reuse pi-ai's native `serviceTier` stream option** — pi-ai already splices `service_tier` for `openai-responses` and applies its own cost multiplier. Rejected: the task mandated the payload-hook splice, and pi-ai's `priority` multiplier is gpt-specific (2x, 2.5x for gpt-5.5), which would misstate Grok billing. The route splices the field only; xAI's own billing owns the price.
- **Expose the tier on the pi-ai profile** — adding `serviceTier` to `PiAiProviderProfile` and threading it through pi-ai's request path would have changed the shared adapter's public contract and collided with the sibling PR's `adapter.ts` hosted-search splice. The additive `onPayload` option is the smallest surface that keeps everything route-owned. The additive `onPayload` option is the smallest surface that keeps everything route-owned.
- **Declare on the installed `xai` catalog provider id** — naming the route `xai` would inherit pi-ai's catalog defaults but collide with the generic `llm-pi-ai` plugin's own catalog declaration of `xai`. The distinct route id `xai-apikey` stays orthogonal.
- **Ship enabled by default** — rejected for the literal default-off contract: this pay-per-token, key-gated route must not advertise a live provider a deployment never opted into.

## Consequences

- A key stored under `XAI_API_KEY` (or any configured `apiKeyEnv`) serves api.x.ai over the shared adapter, with per-model `priority` opt-in splicing `service_tier` only when requested and omitting it on the default tier.
- `llm-pi-ai` gains one additive option (`onPayload`). The real overlap with the sibling grok-hosted-search PR is `adapter.ts` itself: its `hostedSearch` option and this package's `onPayload` both ride pi-ai's single `onPayload` slot, resolved by composing one closure that runs the hosted splice first and then the route hook, chaining non-undefined results. No existing behavior or contract changes.
- The route is mounted dormant in the shipped base composition (`packages/bundle/base/cordis.patch.yml`) and the Models CLI (`apps/cli/src/models-cli.ts`), so it shows configurable from the start; enabling it without a key surfaces `MISSING_CREDENTIAL` at the earliest resolvable point.
- `enabled` default diverges from the sibling routes (which default on): a documented, deliberate deviation for a pay-per-token key-gated route.
