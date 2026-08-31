# Agent Note: J-Space Settings advisor toggle

Status: implemented

## Problem

The advisor was composition-only: a profile patch or `--patch` overlay had to set `enabled`, `provider`, and `model`. Users looking at Settings → J-Space could turn the card on but not the reviewer. Wiki on the same page already had an enable switch and a model binding.

## Decision

Settings → J-Space hosts an Advisor switch over the `jspace-advisor` namespace. On shows provider and model pickers (the same `api.llm.models` catalog as the wiki librarian). Off, or on without both fields, leaves the plugin loaded and mounts nothing — `armed()` still requires enabled + provider + model + an active J-Space seat.

The shipped base bundle inserts `jspace-advisor` with `enabled: false` so the namespace exists for the page. The API proxy allowlists `jspace-advisor` next to `jspace` and `wiki`. `installSettingsSection` overlays the live document onto the composition entry; a settings write remounts `jspace_consult` without a process restart.

## Alternatives considered

**Fold advisor fields into the `jspace` namespace.** Rejected: wiki is already a sibling namespace on this page; mixing reviewer routing into the card seat would couple remounts and settings schemas that change independently.

**Keep composition-only enablement.** Rejected: that is what this page is for. A toggle that does not mount the reviewer is a dead control.

**Fail load when Settings enables the advisor without a model.** Rejected: the user turns the switch on first, then picks a route. Unbound-and-enabled is dormant, matching the wiki librarian.

## Consequences

A deployment that omitted the advisor plugin still hides the Advisor block (`status === 'unavailable'`). Default-off in the base bundle is what makes the block appear on shipped web. Binding a model does not by itself consult or start a review; the J-Space seat must also be on and a card open.

The assembled browser scenario `apps/web/tests/jspace-settings.e2e.ts` pins two ARIA goldens: Advisor off (no pickers) and Advisor on (provider and model comboboxes).
