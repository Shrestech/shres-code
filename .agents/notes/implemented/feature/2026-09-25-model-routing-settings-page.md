# Agent Note: Settings › Model routing, the global routing configuration page

Status: implemented

## Problem

Routing had no global configuration surface. The judgment engine was fixed by composition: the engine registry and its settings selection existed on the Host, but nothing in the GUI listed the engines, showed whether one could answer, or said where conversation text went. The classifier switch sat on the Models page, the default routing mode for new sessions could only be edited in YAML, and TypeSafe and Shield always reported `ready`, so a selector built on the registry would have shown a green state for an engine with no key or no gateway.

## Decision

A new client package, [`ui-settings-model-routing`](../../../../packages/client/ui-settings-model-routing/README.md), registers Settings › Model routing directly after Models, with the header pill "Applies to all sessions". It follows the owner-approved routing UI design v2.1 (`B items 1–3, `D row 9a, `E theme note), which moves every per-session number into the session's Routing view and keeps Settings for configuration only; the pool, Route from, thresholds, and workspace overview are later pages of the same plan ([routing plan](../../proposed/feature/2026-09-24-model-routing-redesign-plan.md), R1).

**Host API.** The dispatcher serves the `judgmentEngines` Remote, whose `snapshot()` returns every registered engine (descriptor facts, required host and whether it admits this machine, per-tier model ids, destination host, state and detail), the resolved `judgment` selection, the declared consumer ids, and this machine's host. It emits the forwarded `judgment/engines-updated` event whenever a new snapshot would differ, so one listener covers engine status and selection. Laya's `laya` Remote exposes `gatewayStatus`, `installGateway`, and `restartGateway`, the operations `/laya` runs; the `Gateway` suffix avoids `install`, which the Client Remote namespace service reserves. Writes never go through these Remotes: the page writes `judgment.engine`, `judgment.enabled`, and `model-router.initialMode` through the settings seam with the section revision, and a rejected write shows the owner's message beside the control, prefixed by the `SettingsFieldError` path when the owner named one. The Routing view (PR 9c) binds the same Remote and event.

**Honest readiness.** TypeSafe reports `unconfigured` while `apiKeyRef` holds no value or no credentials service is mounted, and `unavailable` when the credentials service fails; it re-checks on `credentials/updated`, on status reads while not ready, and after each ask. Shield opens one TCP connection to its endpoint at load, every `readinessIntervalMs` (a new config field, default 30 s), and on status reads while not ready; an answered ask also reports `ready`. Neither sends a judgment request to check. Both finish loading once the first check settles, so a Loader composition never routes an ask while the state is still `starting`.

**Egress wording.** `JudgmentEngineEgress` defines `remote` as off this machine, including hosts on the local network; the badge reads "Remote · egress" or "Local", and a remote engine adds a warning naming the destination host and the router's `state.maxChars` bound, stating that it also appears when a session turns routing on. Warning surfaces use `--dsw-alias-fill-tsp-secondary` with a `--dsw-alias-state-warn-secondary` border, because the dark theme's warn-tertiary fill and warn label are both light.

**Page gating.** The Settings entry is registered only while a `judgmentEngines.snapshot` read succeeds; a gateway `*-unavailable` failure (no dispatcher composed) removes it, and `judgment/engines-updated` or a reconnect re-probes. The shipped Web bundle composes no dispatcher, so it shows no Model routing page.

**Classifier and Models.** The `judgment.enabled` switch moved here; Models keeps one line, a button that opens the section through a new optional `openSection` affordance in the `settings.section` owner props, which the Settings shell supplies.

**Calibration badge.** The selected engine shows "Calibrated" when the resolved `model-router` section has an `operatingPoints` entry for that engine with `calibratedBy` set, and "Uncalibrated" otherwise, the state in which the router routes on its configured defaults. The page already reads that section, so no new Host read is needed; editing operating points and showing their thresholds belongs to PR 9b.

## Alternatives considered

**Keep `ready` for TypeSafe and Shield and surface failures per ask.** Correct for consumers, which take their fallback on `UNCONFIGURED` or `UNAVAILABLE` anyway, but the engine selector would show a green state for an engine that cannot answer, which is the one fact the page exists to show.

**Probe Shield with a judgment request.** A zero-question `/v1/judgments` ask would prove more than a TCP connection, but it is a real request to a deployment-run service on a timer and would consume scripted responses in every test gateway; `/healthz` is a Laya-gateway endpoint the Shield gateway contract does not promise.

**Register the page always and show "not composed".** Every Web user without a dispatcher would see a permanent dead entry; the Routing chip already hides itself the same way when the router is absent.

**Write selections through `settingsScope`.** The shared scope swallows a rejected write and re-reads, which would lose the `SettingsFieldError` path the page must show beside the selector; the page writes through `settings.mutate` directly, as the Models page does.

## Consequences

- Remote egress is visible before a session turns routing on, and switching to a local engine is one selection.
- The Web e2e scenario [`model-routing-settings`](../../../../apps/web/tests/model-routing-settings.e2e.ts) boots TypeSafe without a key and Shield against a closed port, so its goldens pin the `unconfigured` and `unavailable` states and the badge change on an engine switch.
- A real Loader composition in the model-router suite switches `judgment.engine` through the settings seam and asserts that the next decision's engine changes and that the Remote snapshot equals the registry.
- The Laya row reports install progress only as "Installing…"; the Remote carries whether an install runs, not how far it got.
