# Agent Note: Judgment engines register behind one dispatcher

Status: implemented

## Problem

A deployment could compose exactly one judgment provider, and that provider was `ctx.judgment`. Choosing between the remote TypeSafe engine, the local Shield gateway, and later local or third-party engines therefore meant editing the composition and restarting. A Settings control cannot switch engines at runtime under that design, and a deployment cannot send one consumer's asks to a different engine than another's. The [model-routing plan](../../proposed/feature/2026-09-24-model-routing-redesign-plan.md) requires both, with local-first operation and no silent fallback to a remote engine.

## Decision

[judgment-dispatch](../../../../packages/llm/judgment-dispatch/README.md) is the one `ctx.judgment` implementation in a deployment. It provides `ctx.judgmentEngines`, a `JudgmentEngineRegistry` declared by the [judgment Definition](../../../../packages/llm/judgment/README.md#engines). Engine providers no longer extend `JudgmentService`: each injects `judgmentEngines` and calls `registerJudgmentEngine` from its constructor with its engine, a static descriptor, and a status read. The registration is an effect on the provider's fiber. [judgment-typesafe](../../../../packages/llm/judgment-typesafe/README.md) registers `typesafe` (remote egress, terms URL), and [judgment-shield](../../../../packages/llm/judgment-shield/README.md) registers `shield` (local egress, fitting).

The registry rejects a descriptor whose id differs from the registered id, a `supportsFitting` flag that disagrees with the engine's `fitting`, and a duplicate id. It notifies subscribers after every registration, removal, and announced status change, and reports a throwing or rejecting subscriber through the dispatcher's logger without failing the caller.

Every ask goes to one engine: the `judgment.overrides` entry for the ask's new optional `consumer` id, else `judgment.engine`. The dispatcher's required `defaultEngine` config is the section's composition value for `engine`; no engine is chosen by registration order. An unregistered selection fails `UNCONFIGURED`, and a registered engine whose status is not `ready` fails `UNAVAILABLE` with its detail. The dispatcher never asks another engine, so a consumer takes its own engine-unavailable path instead of acting on an answer made under another engine's calibration. Every result, fitted results included, carries `engineId`. `fitting` is a getter that is present while the deployment-wide engine supports fitting; a fitted ask routed by an override to an engine without fitting fails `UNAVAILABLE`.

The `judgment` section becomes `{ enabled, engine?, overrides? }`. The Definition's shape check rejects an empty or valueless engine id by field name. The dispatcher's selection check rejects a write that selects an unregistered engine or an engine whose descriptor names another host. The selection check does not run while the section registers, because a stored selection can name an engine whose provider registers later in the same load. After the Loader settles, the dispatcher logs each selected id that is still unregistered, once per id.

`worker-escalation`, `compaction-jev`, and `judgment-guardrails` send their consumer ids on every ask, so an override can move one of them to another engine. The model router does not send one yet; its asks follow `judgment.engine`.

Every composition that mounted a provider directly now mounts the dispatcher with an explicit `defaultEngine`: the three benchmark overlays, the eight keyless model-router example compositions (whose scripted fixture registers as `snapshot`), and the test compositions of the providers and consumers. The headless bundle declares the dispatcher so profile overlays resolve it.

## Alternatives considered

**Keep one provider per composition.** It needs no registry, but switching engines means a composition edit and a restart, and a per-consumer choice is impossible. Both are owner requirements for the Settings engine switch.

**Fall back to another registered engine when the selected one fails.** It keeps asks answered, but a remote engine silently receives state the deployment chose to keep local, and the consumer acts on probabilities from a different calibration. The dispatcher fails the ask instead.

**Pick the first registered engine when none is configured.** Registration order depends on Loader scheduling, so the answering engine would change between loads without a configuration change. `defaultEngine` is required.

**Validate a stored selection when the section registers.** A settings service that rejects a stored section at registration replaces it with the composition value, so a selection naming an engine that registers later in the same load would be lost. Validation runs on writes and reloads, and the settle-time log reports a selection that never resolves.

**Move `installJudgmentSettings` out of the `JudgmentService` constructor into the dispatcher.** Every single-engine test double would then have to reinstall the toggle its consumer suites exercise. The constructor still installs the section; the dispatcher passes the composition layer and the selection check through it, so a deployment's section is always the dispatcher's.

## Consequences

A settings write switches the engine that answers the next ask without a reload, which the Settings "Model routing" section can drive. A deployment composes several engines side by side and routes a consumer whose state does not fit one engine to another.

A composition that mounts an engine provider without the dispatcher fails to load, because the provider injects `judgmentEngines`. The shipped providers always report `ready` and surface credential and transport failures per ask; a provider that supervises a local process reports its own lifecycle through `status()`.

Routing decisions record the provider-reported `engine` and `model`, not the selected registry id or the operating point it was gated under, and the router's asks carry no consumer id, so a `model-router` override has no effect.

This decision replaces the single-provider `ctx.judgment` mount described in the [shipped Jev routing record](../feature/2026-09-20-jev-judgment-routing-shipped.md) and the [owned Shield judgments record](../feature/2026-09-23-owned-shield-judgments.md); both remain active for their other decisions.

## Verification

- The dispatcher suite covers routing, `UNCONFIGURED` and `UNAVAILABLE` without fallback to a ready second engine, `engineId` stamping on answered and unfit fitted results, per-consumer overrides, fitting availability as the selection changes, write rejection for unregistered and host-mismatched engines, a stored selection whose engine registers late, subscriber failure containment, and the settle-time report in a real Loader composition.
- A real Loader composition with TypeSafe and a second local engine shows a settings write switching which engine answers the next ask, and an override routing one consumer to the other engine.
- The registry suite covers descriptor rejection, notification order, disposal through the provider fiber, and announcements after removal.
- The provider, router, worker-escalation, compaction-jev, and guardrails suites pass with the dispatcher composed, and the consumer suites assert the consumer id on each ask.
- The eight keyless model-router example snapshots replay unchanged with the dispatcher composed.
