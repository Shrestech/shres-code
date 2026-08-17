# Agent Note: Ship the Z.AI catalog route

Status: implemented

## Problem

pi-ai already ships `zai` (`https://api.z.ai/api/coding/paas/v4`, `ZAI_API_KEY`, GLM catalog). The Models page only listed it under **Add a custom provider**, so a Z.AI key had no first-class card, first-run slot, or `shres providers add --template`.

## Decision

`zai` is a shipped `llm-pi-ai` catalog route, same shape as `xai` / `moonshotai`:

- Base composition: `apiKeyEnv: ZAI_API_KEY`. Endpoint, protocol, and models stay the installed catalog (`glm-5.2`, `glm-5.1`, `glm-5-turbo`, `glm-4.7`, …).
- First-run and onboarding offer **Z.AI (GLM)** with default model `glm-5.2`.
- `shres providers add --template zai` writes that same profile.

`zai-coding-cn` stays an add-from-catalog option, not a shipped card.

## Alternatives considered

**Hand-declare a custom `z.ai` gateway.** Rejected: pi-ai already owns the coding endpoint, thinking format, and model list.

**Ship `zai` and `zai-coding-cn`.** Rejected: the product ships one Moonshot / xAI card, not the regional twin. The CN route remains selectable from the catalog picker.

**Delegated `zai-cli`.** Rejected: the request is an HTTP adapter with a stored key, not a product CLI spawn.

## Consequences

A named-but-unset `ZAI_API_KEY` appears on Models and fails with `MISSING_CREDENTIAL` until stored. Seats can bind `zai` / `glm-5.2` the same way they bind any other catalog route.
