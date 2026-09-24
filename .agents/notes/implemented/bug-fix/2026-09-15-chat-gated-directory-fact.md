# Agent Note: Chat-gated directory fact — usability, selection, and the Models card refuse the gated route

Status: implemented

## Problem

`cursor-session` lists and resolves models but every chat turn throws the wire-gate `LlmError` ([cursor subscription session](../architecture/2026-09-15-cursor-subscription-session.md)). No type could express "lists models but chat is gated", so every decision surface treated the route as fully servable: `isDefaultUsable` and the Models join's `providerUsable` counted a keyless profile as ready (on a keyless machine the gated route was the only "ready" one and first-run onboarding was suppressed), `sessions.selectModel` applied and persisted the selection as the default for every future session, and the Models page mapped `llm-cursor-session` to the hint-only `unknown` card whose Apply is disabled, leaving the documented `models` catalog overlay editable only by hand in settings.yaml. The [CLI-route retirement regressions](2026-09-14-cli-route-retirement-settings-regressions.md) repair made the route visible without making its gate legible.

## Decision

`LlmConfigurableProvider` gains an optional `chatGated` fact: when true, the route lists and resolves models but refuses chat turns, and the adapter's stream diagnostic names the serving alternative. `llm-cursor-session` declares it; the wire view `ConfigurableProviderView` forwards it.

- Usability consumers refuse the route: `isDefaultUsable` (first-run setup) and `providerUsable` (the Models join, which also drives `onboardingProviderReady`) return false for a `chatGated` entry, next to the existing delegated-CLI exclusion.
- `sessions.selectModel` refuses a `chatGated` provider with `model-unavailable` after `resolveCallConfig` succeeds and before the selection is applied or persisted as the default; the message is generic because the directory entry carries only a boolean.
- The Models page maps the `llm-cursor-session` namespace to a `session` card layout: the gate notice (rendered while the provider view reports `chatGated`) naming the `cursor-cli` overlay recovery path, plus the shared `DeepSeekModelsEditor` over the `models` settings path with Apply enabled.
- `llm-cursor-session`'s settings section gains a `validate` hook mirroring grok-session: an explicitly empty `models` array rejects at the settings boundary (it would remove the route's picker group; omitting `models` inherits the shipped catalog).
- The [CLI bridge README](../../../../packages/llm/llm-cli-bridge/README.md) carries the worked `cursor-cli` overlay declaration the gate message references; the retired shipped CLI routes are no longer documented as live picker routes.

## Alternatives considered

**Let selection land and rely on the stream diagnostic.** Rejected: the selection is also persisted as the default, so one bad pick poisons every future session, and first-run onboarding stays suppressed on keyless machines — the refusal must precede the write.

**A structured gate descriptor (reason, recovery route) instead of a boolean.** Rejected: one route carries the fact today, the adapter's stream diagnostic already owns the recovery prose, and a wire-carried string would duplicate it; the boolean is the minimal fact the decision surfaces need.

**Gate inside `resolveCallConfig` so every caller inherits the refusal.** Rejected: resolution is also how configuration surfaces interrogate a gated route's catalog; the selection operation is where the decision is made, per the enforce-in-the-operation rule.

## Consequences

A keyless machine no longer treats `cursor-session` as ready, so first-run onboarding appears as intended; selecting the route is refused before anything persists; the Models card edits the advisory catalog without hand-editing settings.yaml; an empty `models: []` fails the settings write naming the consequence. The picker still lists the gated route's models (listing is its honest capability), and a selection stored before the guard still surfaces the adapter's gate diagnostic on chat. The ui-model-selection invariant — a landed selection is one the host can serve — now holds by construction.
