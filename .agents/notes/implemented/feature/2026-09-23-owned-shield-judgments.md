# Agent Note: Owned Shield typed judgments

Status: implemented

## Problem

Model routing consumes binary, choice, and ordered-score judgments. Shield's embedded injection classifier exposes a scalar security probability, which cannot answer arbitrary routing questions. An owned judgment model needs an independent provider without introducing model loading or training into the agent harness.

## Decision

The [Shield judgment provider](../../../../packages/llm/judgment-shield/README.md) implements the existing judgment capability through an explicitly configured loopback service. The Shield repository owns model loading, pinned artifact verification, token limits, training, and evaluation. The harness owns request cancellation, response limits, typed-answer validation, and tier-to-artifact configuration. Each response must identify the requested artifact exactly. The [judgment engine registry decision](../architecture/2026-09-24-judgment-engine-registry.md) registers this provider as the `shield` engine behind `judgment-dispatch` instead of mounting it as `ctx.judgment`.

Routing continues to own its candidate allowlist, current-model alternative, difficulty policy, and manual-model fallback. The provider contributes no routing or security policy. Its answers also remain distinct from the paid Shield host service and enforceable security decisions.

The optional judgment fitting capability accepts ordered complete state alternatives and performs capacity selection and inference as one operation. Each candidate is redacted once before transport. The pinned runtime checks the complete serialized text together with every question, option, and padded batch, then judges the first fitting candidate without truncation. The router bounds the alternatives, removes older whole entries, preserves the complete current user entry, and records the selected redacted text, source omissions, token counts, and artifact manifest hash. A capacity rejection keeps the manual model without inference. The provider bounds the complete serialized UTF-8 request before transport, including all alternatives and questions; the request limit is deployment configuration aligned with the gateway. User-authored source metadata identifies the required current request, so a trailing plugin context message cannot displace it.

The [opt-in routing composition](../../../../bench/routing/route-shield.patch.yml) selects the local provider explicitly through the `route-shield` benchmark arm. It preserves the comparison arm's routing policy, requires routing decisions, and needs no JEV credential. Benchmark defaults exclude this arm because it requires the local service. Default product composition does not imply that a locally runnable checkpoint has demonstrated routing quality. Model-quality evaluation requires observed task outcomes and independent security labels; JEV and original Laya predictions are comparison arms, not ground truth.

The [headless bundle](../../../../packages/bundle/headless/README.md) declares both judgment providers and the router as dependencies. Profile-local module resolution can therefore import explicit routing overlays without relying on unrelated bundles to install their plugins.

The [generation pilot](../../../../bench/routing/generation-model-pilot-2026-09-23-v3.md) collects verifier-backed task outcomes from direct generation models before routing supervision. Its local source snapshot preserves the exact dirty tree without moving the branch or changing the user index. Task success and process termination are separate evidence: a verifier can pass after a budget stop. Readiness requires an unimpeded zero exit and a completed turn alongside verifier success. Configured routes, provider-reported model names, and cached usage also remain distinct; a successful request does not establish backend weight identity or cost.

## Alternatives considered

**Reuse the security probability as a generic judgment.** A prompt-injection probability does not measure a candidate model's ability to complete a task, nor does it define a distribution over arbitrary choices.

**Load the Python model inside the harness provider.** Runtime dependencies, device management, artifacts, and training belong to the model-owning repository. The existing judgment service permits a thin provider without loop changes.

**Check tokens in a separate request before asking.** Independent calls can apply redaction twice or observe different model configuration. Atomic fitting binds the measured input to its inference. Adding separately tokenized entry lengths also cannot account for tokenization at serialized text boundaries.

## Consequences

Deployments must run the local service and configure its exact artifact id. Service absence, input rejection, or an invalid response follows each consumer's existing failure policy. Successful transport and deterministic composition tests establish integration; they do not establish model accuracy, calibration, security recall, or a quality improvement over JEV.

Real Loader composition verifies registration and disposal. Provider tests cover cancellation, redaction, bounded responses, model identity, and complete answer distributions. Router composition verifies that both providers produce request headers consistent with the same durable routing decisions.
