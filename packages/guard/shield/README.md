# shres-shield (host seat)

Default-on Cordis seat for the **paid** Shres Shield plugin. This package resolves `@shrestech/shres-shield-plugin`, checks entitlement, publishes `ctx.shield`, and installs a newer npm release into the boot profile when Settings asks. Detection logic never lives here. The payload contract lives in the sibling `shres-shield` repository at `docs/integration-shres-code.md`.

## Plugin (namespace: `shres-shield`)

```yaml
- id: shres-shield
  name: '@shres-code/shres-code-shield'
  config:
    license: !!js process.env.SHRES_SHIELD_LICENSE ?? ''
    posture: ask
```

`shres-base` inserts this row on every profile. The row mounting is not the same as the engine screening. The seat injects `systemPrompt`, `tools`, `approval`, and `jobs` so the payload adapter can probe those services without throw-as-absent. Product `shres-base` always mounts `approval` and `jobs`; a composition that omits either leaves this row pending, does not publish `ctx.shield`, and does not screen. The Web Settings **Shield** page writes the `shres-shield` namespace (`posture`, `license`, `repos`); this seat remounts the paid payload when that document changes.

### Per-repo exemption (`repos`)

The Settings page also carries a per-repo carve-out map:

```yaml
repos:
  /Users/x/work/noisy-repo:
    enabled: false
```

Keys are absolute repo paths; the Settings page writes the realpath of the current session's workspace. Repo identity is `realpath(session.header.cwd)` — the same key the engine's per-repo stats store uses. The global switch stays master: precedence is `SHRES_SHIELD=off` (`panic`), then diagnostics (`engine-missing`, `unlicensed`), then global `enabled: false` (`disabled`), then a repo entry (`repo-disabled`), then on. An entry can only disable; it cannot re-enable under a global off. The map lives in the host-owned settings document outside every repo tree, so a repo under audit cannot author its own exemption; the only write path is the user-gesture Web settings page — no tool or automation surface reaches it.

The engine mounts once per harness boot, so the gate is a mount gate: when every live session's repo is exempt, the seat stays unmounted with `status.reason === 'repo-disabled'`. Session create/dispose re-evaluates the gate (push), and every `snapshot()` call re-evaluates it (pull) as the safety net for scope-filtered events. While enabled and exempt repos both have live sessions, the engine stays mounted for the enabled ones and still screens the exempt repos — over-screening, the fail-secure direction; exact per-repo suppression needs the engine-side exclusion contract (see Known Limitations).

### Entitlement

`ctx.shield.status.active` is true only when all of the following hold:

- `SHRES_SHIELD` is not `off`
- `@shrestech/shres-shield-plugin` resolves, in order: `SHRES_SHIELD_MODULE` (exclusive when set), the active profile's installed payload (the profile `node_modules` the seat's boot profile anchors), sibling `../shres-shield/packages/plugin/dist/index.js`, then the `@shrestech/shres-shield-plugin` package specifier
- the payload is entitled: a non-empty `license` / `SHRES_SHIELD_LICENSE` (default `shres-dev` until a paid key exists), or the engine loaded from the sibling checkout or `SHRES_SHIELD_MODULE`
- `enabled` is not `false` (Settings → Shield switch; default on)
- at least one live session's repo is not exempt through `repos`; no live sessions counts as enabled

An unentitled or missing payload keeps the seat loaded and `active: false`. The agent loop is unchanged. The product mark stays monochrome.

`license` is a deployment-varying string. This seat does not verify a signature; that check belongs to a later paid-release of the payload.

### `ctx.shield`

`ShieldHost` on `ctx.shield`. Read `status.active` and `status.reason` (`active` | `panic` | `unlicensed` | `engine-missing` | `disabled` | `repo-disabled`). The brand mark uses the current session's snapshot `active` to choose the blue-girl / green-shield lockup.

`ctx.shield.snapshot(sessionId?)` is the Host Remote (`shield/snapshot`) for the Settings console. It returns `{ status, stats, definitions?, payload? }` for the current session cwd (`realpath(session.header.cwd)` when a live session is known). Counts live in the engine's per-repo store, not `settings.yaml`. Disable and panic remount the payload off and still read module-level `stats.snapshot()` so last persisted counts remain with `status.reason === 'disabled'` or `'panic'`. The snapshot's `status` is per-repo: while the engine screens other repos, an exempt repo's snapshot reports `'repo-disabled'`; diagnostic and global-off reasons always pass through. `payload` is the resolved engine source and npm version when a file loaded.

`ctx.shield.checkUpdate()` GETs `https://registry.npmjs.org/@shrestech/shres-shield-plugin/latest` and compares that `version` to the resolved package.json. `ctx.shield.applyUpdate()` re-checks, then `pnpm add @shrestech/shres-shield-plugin@<version>` in the boot profile and remounts. `SHRES_SHIELD_MODULE` is exclusive and blocks the install; a missing profile directory also blocks. Settings → Shield **Check for updates** / **Update** are the product path.

The seat declaration-merges `'shield/decision'` onto `SessionEventMap`. The payload is the W1 decision body (`verdict`, `rule`, `reasonCode`, `channel`, `sha16`, optional `host` / `callId` / `origin` / `turn` / `step`). Writers pass `{ ignorable: true }` so older readers resume. `SESSION_FORMAT_VERSION` stays `0`.

## Model Experience

### Request context and condition

#### What the model sees

When the paid engine applies, it injects the `shres-shield:doctrine@N` system-prompt section and may replace or annotate tool results. The verbatim doctrine text is owned by `@shrestech/shres-shield-plugin`. This seat contributes no model-visible text of its own.

#### Token effect

Zero when inactive. When active, the doctrine section is a small retained prefix; blocked or replaced tool results substitute a short placeholder for the original payload.

#### KV Cache effect

Inactive: none. Active: the doctrine section is prefix-stable for a given plugin version; replacements are append-only on the tool-result suffix.

## Known Limitations and Deferred Work

- **License strings are not signature-verified** — a non-empty `license` entitles a package- or profile-resolved payload; cryptographic verification is deferred to the paid release of `@shrestech/shres-shield-plugin`.
- **Concurrent mixed-repo sessions over-screen** — the repo gate is a mount gate over the live session set; when enabled and exempt repos both have live sessions, the exempt repos stay screened. Exact suppression needs an engine-side exclusion contract in the sibling `shres-shield` repo (`apply` config or a suppression callback in `docs/integration-shres-code.md`).
- **Ask posture needs an open-turn `ctx.approval.request`** — the payload adapter maps `'allowed-once'` and fail-closes without an `agent` on the live tool execution; headless compositions stay fail-closed.
- **The payload is not a workspace dependency** — CI without a sibling checkout or `SHRES_SHIELD_MODULE` loads the seat as `engine-missing` and does not screen.
- **Definition freshness is optional on the snapshot** — the pane shows `—` until the engine reports `definitions`. Plugin npm updates are a separate RPC (`checkUpdate` / `applyUpdate`), not a SIG-PACK refresh.
