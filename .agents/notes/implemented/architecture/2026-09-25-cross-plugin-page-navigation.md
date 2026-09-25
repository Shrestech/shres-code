# Agent Note: Cross-plugin full-page navigation

Status: implemented

## Problem

The frame kept its full-page destination (Settings and its sections) in AppFrame's React state, and only the `shell.navigation` occupant received it, so a plugin outside Settings could not link to a Settings section. PR 9c's Routing view needed a link to Settings › Model routing, and its first mechanism let any plugin call `ctx.layout.navigate(page)` with a raw page string. That made the frame the owner of an unchecked vocabulary: a typo or a section that is not composed would navigate to an empty Settings page, and every feature package would depend on `ctx.layout` to reach Settings.

## Decision

The mechanism is split by owner. [ui-layout](../../../../packages/client/ui-layout/README.md) keeps `ctx.layout.navigate(destination | null)` as the frame primitive: the destination lives in the transient layout store (never persisted, so a reload shows the workspace) and reaches the `shell.navigation` occupant as its `page` owner prop. A destination id is owned by the destination's provider, which validates it before calling the primitive.

Settings section ids are the settings domain's vocabulary. [ui-settings](../../../../packages/client/ui-settings/README.md) declares `ctx.settingsPages` (`ISettingsPages`); its `open(sectionId)` checks the id against the live `settings.section` ledger and rejects with an error naming an id no section registered (misconfiguration fails loud). A call made before `settings.section` is declared waits for the declaration, the `slots.inject` pattern, and then one microtask so the sections registering inside the declaring `register()` call are on the ledger; only then does it call `ctx.layout.navigate`. A pending call rejects when the face is withdrawn.

The face is provided by [ui-settings-general](../../../../packages/client/ui-settings-general/README.md), the shell that declares `settings.section`, inside `ctx.inject(['layout'])`. ui-settings cannot provide it: ui-layout depends on ui-theme, which depends on ui-settings, so a ui-settings dependency on ui-layout would be a package cycle. The contract (interface and `Context` merge) stays in ui-settings, where feature packages already depend.

Feature components follow the client rules: the apply world binds `ctx.settingsPages.open` into a plain `(sectionId) => void` callback in the component's inject face. The Models page's "Model routing" link is the first consumer; the `openSection` owner prop that 9a gave every section is removed, so links between sections take the same checked path, and a section's owner share carries only `close`. `ui-layout/tests/navigate-callers.client.spec.ts` allows only the Settings pages provider to call `ctx.layout.navigate` in the client packages.

## Alternatives considered

**Let features call `ctx.layout.navigate` with section ids.** It is the smallest change, but nothing checks the id, and the frame would carry the Settings vocabulary in its contract.

**Provide `ctx.settingsPages` from ui-settings itself.** It matches the contract's home, but needs `ctx.layout`, which closes the ui-settings → ui-layout → ui-theme → ui-settings cycle.

**Wait for an unregistered id instead of rejecting.** A section such as Model routing registers only after its Host probe, so waiting would sometimes succeed; but an id that never registers would leave the call pending forever with no signal. Rejecting once the slot is declared makes a missing or misspelled section visible at the first click.

**Keep the `openSection` owner prop for links inside Settings.** It works without the face, but it is a second, unchecked path to the same navigation.

## Consequences

- PR 9c's Routing view links to Model routing with `ctx.settingsPages.open('model-routing')`; it lands after this change.
- A link naming a section that is not composed rejects with `settings: no Settings section "<id>" is registered` in the browser console instead of opening an empty page.
- No user-visible change by itself: the Models page link opens Model routing as before, now through the checked face; the web e2e `model-routing-settings` clicks it and asserts the Model routing page is current.
