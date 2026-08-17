# @shres-code/shres-code-client-ui-settings-shield

Browser Settings page for the paid Shres Shield host seat. It registers a `settings.section` row (`id: shield`, order 12, between Models and Plugins) and binds the Host `shres-shield` namespace.

The page leads with an activate/disable switch beside the Shield mark (blue/green while on). It edits `posture` (`observe` / `ask` / `enforce`) immediately and writes `license` only when Apply is pressed. License defaults to `shres-dev` until a paid key exists. `SHRES_SHIELD=off` remains the panic switch and is not a settings field.

The Host seat (`@shres-code/shres-code-shield`) owns the namespace and remounts the paid payload when these fields change. This package never imports the Host package.

## Model Experience

None, as the section renders a browser configuration UI; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Live screening status is not on this page** — `ctx.shield.status` stays host-local. The sidebar mark (blue girl, green shield) is the user-visible active signal.
- **License strings are stored in `settings.yaml`** — they are not a credential-store secret slot in this change.
