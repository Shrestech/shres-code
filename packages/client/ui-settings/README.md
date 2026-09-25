# @shres-code/shres-code-client-ui-settings

The settings domain's base layer provides `ctx.settingsScope`, the Host transport for durable preference namespaces, and the slot types consumed by feature plugins. Chrome uses `settings.trigger`, `settings.header`, `settings.close`, and `settings.action`; feature pages use `settings.section`; individual preferences use `settings.general.item` or `settings.audio.item`; plugin pages use `settings.plugins.tab`; ordered first-run flows use `settings.onboarding`. Presentation lives in ui-settings-general, which occupies `shell.navigation`. The base layer depends on no presentation package.

Settings section ids are this domain's vocabulary for full-page destinations. The contract declares `ctx.settingsPages` (`ISettingsPages`): `open(sectionId)` opens Settings at a registered `settings.section` entry and settles once the frame shows it. The id is checked against the live `settings.section` ledger: an id no section registered rejects with an error naming it, and a call made before the shell declared `settings.section` waits for that declaration and the sections registered with it. A feature component receives a plain `(sectionId) => void` callback in its inject face; its apply world binds it to `ctx.settingsPages.open`, so no feature package passes a page string to `ctx.layout`. The face is provided by ui-settings-general, the shell that declares `settings.section`, because this base layer cannot depend on ui-layout (ui-layout depends on ui-theme, which depends on this package).

The plugin injects nothing and waits for nothing: `ctx.settingsScope.bind(spec)` resolves the wire face through the CALLER's context at call time, so the bound scope's disposer belongs to the calling fiber, and the caller injects `connection` for the transport and `remote` for the invalidation. Listeners exist before the first background read starts, so a row's activation never blocks on the settings transport. A bound scope reloads on the forwarded `settings/document-updated` event for its own namespace and on `connection/reset`. Writes carry one field path and the last known namespace revision as `expectedRevision`; a rejected or failed write re-reads unless a newer write already superseded it, and a stale read never publishes over a newer one. Without a `decode` in the spec, a section that is not a plain object, fails its rehydrated schema, or carries a schema envelope this client cannot rehydrate publishes no value at all, so a row renders its own absent state instead of a half-decoded one.

## Model Experience

None, as the settings domain base serves browser preference storage and slot declarations; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Remote browsers get no durable settings** — the settings RPCs are loopback-only, so a scope bound in a non-loopback browser starts `unavailable` and never crosses the wire; every row it backs is inert there.
- **One field per write** — `set` sends a single `set` op, so a row that must move two fields together has no transaction and publishes two revisions.
