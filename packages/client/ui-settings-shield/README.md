# @shres-code/shres-code-client-ui-settings-shield

Browser Settings page for the paid Shres Shield host seat. It registers a `settings.section` row (`id: shield`, order 12, between Models and Plugins) and binds the Host `shres-shield` namespace.

The page leads with an activate/disable switch beside the Shield mark (blue/green while on). It edits `posture` (`observe` / `ask` / `enforce`) immediately and writes `license` only when Apply is pressed. License defaults to `shres-dev` until a paid key exists. `SHRES_SHIELD=off` remains the panic switch and is not a settings field.

Below the switch the same page is the security console: this-repo path, screened / asked / blocked / observed, the top fired rule ids, recent findings, and a definition stamp (`—` until the engine reports one). Those fields come from `ctx.remote.shield.snapshot()`, not from the `shres-shield` settings document. Disable stops new increments and still shows last persisted counts.

The Host seat (`@shres-code/shres-code-shield`) owns the namespace and remounts the paid payload when these fields change. This package never imports the Host package.

## Model Experience

None, as the section renders a browser configuration UI; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Live screening status is not on this page** — `ctx.shield.status` stays host-local except as the snapshot's `status` copy. The sidebar mark (blue girl, green shield) is still written from the Settings switch.
- **License strings are stored in `settings.yaml`** — they are not a credential-store secret slot in this change.
- **Update now is not on this page** — the definition stamp is a placeholder until the engine refresh RPC exists.
