# shres-shield (host seat)

Default-on Cordis seat for the **paid** Shres Shield plugin. This package resolves `@shres-shield/plugin`, checks entitlement, and publishes `ctx.shield`. Detection logic never lives here. The payload contract lives in the sibling `shres-shield` repository at `docs/integration-shres-code.md`.

## Plugin (namespace: `shres-shield`)

```yaml
- id: shres-shield
  name: '@shres-code/shres-code-shield'
  config:
    license: !!js process.env.SHRES_SHIELD_LICENSE ?? ''
    posture: ask
```

`shres-base` inserts this row on every profile. The row mounting is not the same as the engine screening. The seat injects `systemPrompt`, `tools`, `approval`, and `jobs` so the payload adapter can probe those services without throw-as-absent. Product `shres-base` always mounts `approval` and `jobs`; a composition that omits either leaves this row pending, does not publish `ctx.shield`, and does not screen. The Web Settings **Shield** page writes the `shres-shield` namespace (`posture`, `license`); this seat remounts the paid payload when that document changes.

### Entitlement

`ctx.shield.status.active` is true only when all of the following hold:

- `SHRES_SHIELD` is not `off`
- `@shres-shield/plugin` resolves, in order: `SHRES_SHIELD_MODULE` (exclusive when set), sibling `../shres-shield/packages/plugin/dist/index.js`, then the package specifier
- `enabled` is not `false` (Settings → Shield switch; default on)
- a non-empty `license` / `SHRES_SHIELD_LICENSE` (default `shres-dev` until a paid key exists), or the engine loaded from the sibling checkout or `SHRES_SHIELD_MODULE`

An unentitled or missing payload keeps the seat loaded and `active: false`. The agent loop is unchanged. The product mark stays monochrome.

`license` is a deployment-varying string. This seat does not verify a signature; that check belongs to a later paid-release of the payload.

### `ctx.shield`

`ShieldHost` on `ctx.shield`. Read `status.active` and `status.reason` (`active` | `panic` | `unlicensed` | `engine-missing`). The brand mark uses `active` to choose the blue-girl / green-shield lockup.

## Model Experience

### Request context and condition

#### What the model sees

When the paid engine applies, it injects the `shres-shield:doctrine@N` system-prompt section and may replace or annotate tool results. The verbatim doctrine text is owned by `@shres-shield/plugin`. This seat contributes no model-visible text of its own.

#### Token effect

Zero when inactive. When active, the doctrine section is a small retained prefix; blocked or replaced tool results substitute a short placeholder for the original payload.

#### KV Cache effect

Inactive: none. Active: the doctrine section is prefix-stable for a given plugin version; replacements are append-only on the tool-result suffix.

## Known Limitations and Deferred Work

- **License strings are not signature-verified** — a non-empty `license` entitles a package-resolved payload; cryptographic verification is deferred to the paid release of `@shres-shield/plugin`.
- **Ask posture needs an open-turn `ctx.approval.request`** — the payload adapter maps `'allowed-once'` and fail-closes without an `agent` on the live tool execution; headless compositions stay fail-closed.
- **The payload is not a workspace dependency** — CI without a sibling checkout or `SHRES_SHIELD_MODULE` loads the seat as `engine-missing` and does not screen.
