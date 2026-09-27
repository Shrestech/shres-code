# `@shres-code/shres-code-browser-bundle`

The optional BrowserSkill layer for the Shres Web surface. Select this bundle after [`shres-web-app`](../web-app/README.md) in `shres.profile.bundles` to mount the managed BrowserSkill host tools and the BrowserSkill Plugins section together. The layer does not download runtime assets or open a browser; the user starts provisioning from **Plugins → BrowserSkill** after the host is running.

The bundle has no runtime API. Its [`cordis.patch.yml`](cordis.patch.yml) inserts [`shres-browserskill`](../../browser/browserskill/README.md) and [`ui-browserskill`](../../client/ui-browserskill/README.md), and the profile composer resolves the patch through the `shres.bundle.patch` manifest field.

## Model Experience

Indirectly, through the selected BrowserSkill host package: its tools and runtime guide are absent until this bundle is selected, and the guide directs the user to **Plugins → BrowserSkill** for consent and readiness.

#### KV Cache effect

Selecting or removing the layer changes the mounted tool catalog and therefore the model request prefix after the next profile restart.

## Known Limitations and Deferred Work

- **macOS arm64 with an installed Google Chrome** is the supported BrowserSkill platform. The Plugins flow reports unsupported platforms before downloading anything.
- **Selection requires a profile restart** because bundle layers are composed before the host and browser module graph mount.
