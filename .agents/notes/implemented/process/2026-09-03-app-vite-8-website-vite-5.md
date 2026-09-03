# Agent Note: Web app Vite 8, documentation site Vite 5

Status: implemented

## Problem

`@vitejs/plugin-react` 6 declares a `vite` `^8` peer. The web app still pinned Vite 6 after that plugin major landed, so `pnpm` reports an unmet peer and the React-refresh transform is the Vite 8 Oxc path, not the Vite 6 Babel path. Dependabot's matching Vite 8 pull request also rewrote `website/package.json`, and VitePress 1.6.4 is a Vite 5 toolchain.

## Decision

`apps/web` pins `vite` `^8.2.0` next to `@vitejs/plugin-react` `^6.0.5`. The documentation site keeps `vite` `^5.4.14` for VitePress 1.6.4. `apps/web/vite.config.ts` continues to call `react()` with no Babel options.

## Alternatives considered

**Take website Vite 8 in the same bump.** Rejected: VitePress 1.6.4 does not support Vite 8; a site-major Vite jump waits on a VitePress major.

**Leave the web app on Vite 6 with plugin-react 6.** Rejected: it violates the plugin's peer range and keeps the app on a bundler major the plugin no longer targets.

**Stay on plugin-react 4 until a coordinated Vite 8 + plugin 6 change.** Rejected after the plugin 6 bump already landed; the remaining work is the matching app Vite major.

## Consequences

The web app and the documentation site pin different Vite majors on purpose. A future Dependabot Vite bump that touches `website/package.json` must be split or dropped until VitePress supports that major. plugin-react 6 removes Babel from the plugin; adding a Babel plugin to the web build now requires `@rolldown/plugin-babel` beside `react()`, not a `babel` option on `react()`.
