# Agent Note: Desktop host child process

Status: implemented

## Problem

The desktop application must boot an installed shres project without a listening socket: the Electron shell owns the window and custom scheme, and a bound port would re-introduce the web threat surface (DNS rebinding, cross-site reads) the served web app carries fences for. The browser page also cannot open WebSockets over the custom scheme, so the served client's downlink carrier cannot work unchanged.

## Decision

`apps/desktop-host` is a private Node child process speaking framed byte pipes (magic `0x53485233`, protocol v1, fds 3/4, 64 KiB chunks, monotonic stream ids, request-body backpressure by pipe pause). It loads the desktop project profile with `loadProfileDirectory` (PR1) under a patch layer that disables the socket-bound rows and inserts the native picker pair, then dispatches: `/api/*` through `HostConnectionService`'s shared handler with the loopback pin unset — the pipes are single-user dispatch, not a socket — with POST on the two event paths answering newline-delimited server-request envelopes built from `apiProxy.events` (the fetch-stream downlink contract from the transport seam note); `/plugins/*` through a new public `clientModules.fetchBundle`; assets from the built frontend dist with `injectBootManifest` and the `__SHRES_TRANSPORT__` script prepended, decode-then-contain path checks, and SPA fallback. The host constructs `HostConnectionService` itself unless the composition provides a Connection service carrying the shared handler (stub-hosted fixtures). Path traversal through this entry is structurally neutralized — URL parsing consumes real dot segments and one decode of double-encoded segments yields a literal `%2e%2e` name — with resolve + realpath containment as defense-in-depth.

## Alternatives considered

**Port upstream's `remote-stream` carrier and `openStream` hook member.** Rejected: this tree's Typert Remote endpoints already ride the `/api` route through the registered interceptor, so a separate stream path has no caller; the client seam ships exactly `fetch` + `ownsHost`.

**Reuse the booted Connection service for the shared handler.** Rejected: the desktop patch disables the connection row whose node half is webserver-bound and cannot activate without one; nothing would provide the service at boot.

**Serve client bundles through the registry's private `clientPath`.** Rejected: private members are undefined on the real service at runtime; `fetchBundle` is the public carrier-agnostic face (the web route and the desktop host now share one resolution path).

## Consequences

The desktop page runs the unmodified served client: the transport global flips its carrier to fetch-stream downlinks and grants loopback authority. A real desktop profile must install the two inserted picker packages (the packaging stage owns that; fixtures stage no-ops). The Electron shell (next PR) spawns this process with the pipes and forwards `shres-app://` fetches into `runDesktopHost`'s controller. Stage B (ASAR + signing) moves packaging, not this dispatch design.
