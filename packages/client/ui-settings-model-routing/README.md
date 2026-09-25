# @shres-code/shres-code-client-ui-settings-model-routing

Browser Settings page for model routing configuration that applies to every session. It registers a `settings.section` row (`id: model-routing`, order 10.5, directly after Models) while the Host serves the `judgmentEngines` Remote, and removes it when a read reports that no judgment dispatcher is composed. The page header carries the pill "Applies to all sessions"; per-session routing stays with each session's Auto chip.

The page has three cards:

- **Judgment engine.** A selector over every engine the Host's registry lists (`judgmentEngines.snapshot()`), each option naming its egress; an engine whose descriptor requires another host is listed but disabled. The selected engine shows its live state (with the provider's detail while not ready), its egress badge ("Remote · egress" or "Local"), its model ids, and "Uncalibrated", because routing thresholds have not been evaluated for any engine. A remote engine adds a warning that conversation excerpts leave this machine, naming the destination host and the router's `state.maxChars` bound, and saying that the warning also appears when a session turns routing on; `remote` means off this machine, including a host on the local network. Changing the selection writes `judgment.engine` through the settings seam with the section revision; a rejected write shows its message beside the selector, prefixed by the field path when the owner named one (`SettingsFieldError`). When the registry lists `laya`, the card adds the Laya row: gateway state, pinned artifact, context size, and Install, or Restart and Reinstall… (after a confirmation), through the `laya` Remote, which runs the same operations as `/laya`.
- **Default for new sessions.** Off / On writes `model-router.initialMode`. This is the only place the default is shown or edited; a session's own choice through the Auto chip is unaffected.
- **Classifier.** The `judgment.enabled` switch, moved here from the Models page; off makes every judgment consumer treat the engine as absent.

The page reads the engine view, the `judgment` and `model-router` settings sections, and the Laya view when it mounts, and re-reads them on `judgment/engines-updated`, on `settings/document-updated` for either namespace, and on `connection/reset`. Before it first mounts, those invalidations only re-probe the engine view, which decides whether the entry is registered. Every write re-reads the page afterwards. The page model lives in the plugin's `apply` and reaches the component through the inject `hooks` compartment; the component holds no subscription of its own.

## Model Experience

None, as the page renders a browser configuration UI; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No candidate pool, Route from, thresholds, or workspace overview** — those cards arrive with their own Host reads (the pool editor and read-only thresholds with PR 9b, the workspace overview with PR 9d).
- **Laya install progress is a state line** — the `laya` Remote reports whether an install is running, not how far it got; the row shows "Installing…" until the gateway state changes.
- **The Shadow mode is not offered** — the default-mode control shows only the modes that exist, Off and On.
