# Agent Note: Desktop profile activation

Status: implemented

## Problem

The desktop app could not select any profile bundle. Its launcher reported `pluginMutations: 'unsupported'` for the whole plugin-admin namespace, so the Plugins Bundles tab listed nothing (`listBundles` returned `[]` without an install anchor) and every bundle toggle answered `{ kind: 'unsupported' }`. The shipped BrowserSkill bundle was installed in the runtime and resolvable from the app manifest, so the only way to mount the browser tools was to hand-edit `$SHRES_HOME/profiles/desktop/package.json`. One flagged capability stood for three separate operations — bundle selection, plugin-row overrides, package install/removal — that have different owners and different failure modes, and the desktop could execute two of them.

## Decision

[ProfileRuntime](../../../../packages/boot/app-boot/src/profile-runtime.ts) carries two capabilities, `{ activation, packages }`, each copied and frozen by `provideProfileRuntime`. `activation` covers bundle selection and plugin-row overrides, which rewrite only the profile manifest and its patch layer; `packages` covers the pnpm-backed install and removal transactions. The [pluginAdmin gateway](../../../../packages/host/plugin-admin/README.md) branches per capability: `status()` reports the record (both false without a runtime), `listPlugins`/`listBundles` attach `readOnlyReason` only when `activation` is false, and `stageInstall`/`removePlugin` refuse when `packages` is false. The gesture is spent before the capability verdict, so a forged call learns nothing about host state.

The desktop host provides `{ activation: true, packages: false }` (Windows reports `activation: false`, matching the shared core's platform refusal), an `installAnchor` at the installed app manifest, `shippedBundles` derived as the booted layers plus `OPTIONAL_BUNDLES`, and a control that saves without reconciling. Its `apply` returns `restart-required` and `overridden` when the desktop patch outranks the row it just saved, so a saved override the next launch will not honour is never reported as a success.

Bundle selection carries no override check because no launcher layer reselects bundles: the desktop composition reads `shres.profile.bundles` directly. Row overrides do carry one, because the desktop patch is applied after the profile patch and can outrank a saved row.

The desktop preselects nothing: `DESKTOP_PROFILE_BUNDLES` stays base + web-app, `OPTIONAL_BUNDLES` stays outside every template, and `ensureDesktopProfile` never rewrites an existing manifest. BrowserSkill is a user choice whose tools cost every request's schema prefix; the enablement fix is the route, not a default. `apps/desktop` remains a launcher-owned profile rather than a `PROFILE_TEMPLATES` entry, because the shell owns creation and versioning.

## Alternatives considered

**Preselect the browser bundle in new desktop profiles.** It helps only profiles created after the change, keeps every existing desktop profile on hand-editing, and charges the fixed tool-schema and guide cost to users who will never browse. It also leaves no off switch, because deselecting needs the very activation path this decision adds.

**A third union value such as `'activation-only'`.** Stringly-typed middle states force every call site to remember which comparisons accept them; a record makes the compiler ask per capability, and the two capabilities are genuinely independent — a future host may own a package manager without owning a live profile.

**Full live reconciliation in the desktop host.** The mutation response travels through the Loader tree a reconciliation would rewrite, and the desktop composition disables `client-hmr`, so no client module-graph driver exists. Reporting `applied` would be false for the client half.

**Keep `pluginMutations: 'unsupported'` and document hand-editing.** This is the state that produced the bug report; the manifest is app-owned and users should not need to know its format.

## Consequences

Selecting BrowserSkill in the desktop Plugins Bundles tab saves the selection and reports that a restart is required; the tools and guide mount on the next launch, and runtime provisioning still needs the separate consent in **Plugins → BrowserSkill**. Package installs stay unavailable in the desktop until an owner for the profile's pnpm and lock exists. The app document receives no restart affordance today (`preload-app.ts` exposes only `protocolVersion` to `shres-app://app`), so the restart is a quit-and-reopen; adding one needs a new host capability seam.

The desktop `/api` carrier is unchanged and still passes no `PRIVILEGED_METHODS` set: the pipes are single-user dispatch, and the pin's Host fence cannot be satisfied by a `shres-app://app` request, so passing the set would refuse every pinned method. This note records that fact because the enablement depends on it.

Evidence: `apps/desktop-host/tests/desktop-host.spec.ts` asserts the provided runtime facts and the save-without-reconcile outcomes over a staged profile; `examples/headless-agent/tests/browser-bundle.snapshot.ts` boots the real Loader twice over the same fixture and pins both the live-reconciling CLI shape and the activation-only shape (`activation: true`, `packages: false`, install refused, disable saved as restart-required while the running tree keeps its tools). The desktop save-then-relaunch path is pinned in two halves — the host's runtime facts and outcomes, and the activation-only gateway over a real Loader — because the desktop fixture composition mounts stub host services rather than the plugin-admin row itself.
