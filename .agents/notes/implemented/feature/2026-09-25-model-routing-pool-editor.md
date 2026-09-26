# Agent Note: The shared pool editor, Route from allowlist, and read-only thresholds of Settings › Model routing

Status: implemented

## Problem

The routing settings page (9a) carried no way to configure the pool or the bases routing runs from: the candidate pool and `routeFrom` were YAML-only, a wrong provider name surfaced as a runtime failure instead of a write-time rejection, and the thresholds the router gates consults with were invisible, so an owner could not tell whether routing was calibrated or running on the global floors. The per-session Routing view shows what happened; nothing showed what was configured.

## Decision

Settings › Model routing gained the shared pool editor, the Route from allowlist, and the read-only thresholds card, per the pool-card delta of the [routing plan](../../proposed/feature/2026-09-24-model-routing-redesign-plan.md).

**One write for both lists.** The pool and `routeFrom` are held as one draft and written in a single `settings.mutate` call carrying both fields, so a pool edit and a Route from edit never land apart. An entry the owner has not finished — a `routeFrom` entry without an objective — is never sent: it stays in the unsaved draft with an inline explanation, and the save-again affordance appears only once every entry is complete. Every-turn entry is a separate opt-in allowance on a quota route, not a precondition: the switch writes or drops the field, and the router's validation decides whether the deployment's rule admits the entry.

**The Host validates, the page locates.** Every rule of the pool-card delta (unique non-`keep-current` ids, non-empty routes, required descriptions of at most 160 characters, required objectives, the latency deadline ceiling, the every-turn allowance for quota routes) is enforced by the router's settings validation at write time. The page adds no duplicate rules; it only refuses to submit a row whose id or description is empty. A rejected write carries the `SettingsFieldError` path, and the editor pins the message to the offending row, to the offending list, or — for a failure that names neither list — to the pool card, where the pool is the primary subject.

**Notes name capability and token facts only.** Beside each stored row, `modelRouting.poolStatus()` supplies where a model is eligible from, where it never is and why, cross-membership with a Route from model, whether the provider route is registered, and whether usage reports cache counts. The router has no cost or strength order, so the notes never price a model.

**One calibration source.** The router serves its gate through the `modelRouting.gate()` Remote read (`downgradeThreshold`, `downgradeMargin`, operating points with `calibratedBy`, deadline, difficulty band, hold, state cap, and per-engine calibration). Both the engine card's router badge and the thresholds card render that one read through the shared `engineCalibration` helper, so the two cards cannot disagree. This replaces the 9a reading of the resolved `model-router` section for the badge ([the settings page note](2026-09-25-model-routing-settings-page.md)); the section remains the source for the mode control and the egress bound.

**The judge hint degrades honestly.** The description editor's hint names the judge's token budget while the routed engine is the local Laya gateway and its gateway view is known, and stays generic otherwise. The load-time head check (plan R2.5) has no Host surface yet, so the hint states the checkpoint context rather than a measured head-token figure.

## Alternatives considered

**Writing each list as its own settings write.** Simpler rows, but a pool edit that removes a model and a Route from edit that adds its base would land as two configurations, and a failure between them would leave the pool describing bases it is never consulted from. The combined write keeps the two lists one decision.

**Repeating the router's validation rules in the browser.** Faster feedback, but two rule sets drift; the settings write already returns the owner-named field path, and rendering that message beside the row keeps one authority. The page keeps only the empty-input guard, which is a form-usability affordance rather than a rule.

**Deriving eligibility notes from the catalog client-side.** The catalog lists models but not capability floors, thinking modes, or hosted tools; only the router's eligibility check knows why a pair fails. Recomputing it in the page would duplicate the router's fail-closed logic in presentation code.

**Showing the head-token figure from `JudgmentTokenLimits.maxHeadTokens` now.** The fitting limits exist on the wire, but no Host surface exposes the selected engine's limits or the load-time head check to a client, and inventing one was outside this change; the hint names the checkpoint context until the head check ships.

## Consequences

- An owner can build the live configuration entirely in the GUI: pick pool models from the `llm.models` catalog, describe them for the judge, enable strong models with objectives, and read the thresholds routing applies — all opt-in, nothing routes until a session turns routing on.
- The web e2e scenario [`model-routing-settings`](../../../../apps/web/tests/model-routing-settings.e2e.ts) pins the new cards in both engine states alongside the engine selector goldens.
- Editing thresholds is still not offered; they change through preregistered evaluations and `model-router.operatingPoints` in YAML, and the card is labeled read-only on purpose.
- The workspace overview (9d) remains a separate later card with its own Host read.
