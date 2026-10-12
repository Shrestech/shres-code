# Agent Note: Desktop profile patch watch

Status: implemented

## Problem

The desktop host reads `cordis.patch.yml` in the desktop profile only while booting. The web app and the CLI watch that file and `$SHRES_HOME/cordis.patch.yml` through Cordis HMR, so an MCP client row or another profile-patch edit reconnects without exiting the process. The desktop app had to be quit and opened again for the same edit. MCP reconnect gives up after its attempt budget, and nothing in the running desktop host loads that plugin again.

## Decision

`runDesktopHost` watches the profile's `cordis.patch.yml` after the composition provides `clientModules`. The web bundle disables the shared module-reload `hmr` row, so a missing HMR service is mounted with `root: []`, after `timer` when that service is also missing. Each refresh reapplies the profile patch between the boot bundle layers and the shipped `desktop.cordis.patch.yml` overlay, including the system agent-preset root when that row is composed. Those app-owned layers are cloned at registration so an include update cannot bake a profile override into them. A malformed patch is rejected by the existing HMR transaction and the previous composition stays. Bundle membership in `package.json` is unchanged and is still read only at launch. `pluginMutations` stays `unsupported`. The user-wide `$SHRES_HOME/cordis.patch.yml` is not loaded.

## Alternatives considered

- **Slash commands `reload-mcp`, `reload-skills`, and `reload-plugins`.** Rejected. Skill files already refresh from their own watcher. A command would be a second way to reapply the same patch file the CLI already reloads by saving it.
- **Watch `$SHRES_HOME/cordis.patch.yml` from the desktop host.** Rejected for this change. The desktop composition does not apply that file at boot, so watching it would introduce a layer the host has never loaded.
- **Turn `pluginMutations` to `enabled`.** Rejected. The desktop host has no plugin-install owner. Bundle installs stay restart-required.

## Consequences

- Saving the desktop profile patch changes MCP servers, model routing, and other rows in that file while the app stays open.
- A failed MCP client stays down until the patch is saved again or the host process starts again. The watch does not retry a client that already gave up.
- Selecting or removing a profile bundle still needs a new host process.
- Watch setup failure disposes the host and fails the boot. A host that cannot reload its profile patch does not advertise a ready composition.
