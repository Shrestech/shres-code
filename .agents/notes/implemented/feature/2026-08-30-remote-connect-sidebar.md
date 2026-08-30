# Agent Note: Sidebar Remotes group — connect UI

Status: implemented

## Problem

The web GUI could read the remote registry and the host already owned gesture-gated connect, but connecting to a remote host was still a CLI action. The user works in the browser: one row per alias, a first-connect trust decision, and a connected badge had to be GUI gestures driving `remoteAdmin`, not a pasted `shres remote connect` URL.

## Decision

A new client package `packages/client/ui-remote` registers one `RemotesSection` into the sidebar shell's `sidebar.remotes` hole (declared by `ui-sidebar`, stacked above `sidebar.workspaces`). The apply closure owns a `createRemoteViewStore` projection of `remoteControl/list`, `remoteAdmin/status`, and the forwarded `remote-control/tunnel-state` event, and hands the section plain callbacks: inspect opens the trust modal; confirm mints a `begin` grant and spends it on `connect`; add/edit/remove spend their own grants. Components never see tokens.

Connecting is a two-step conversation. A row click runs `inspect` and opens the trust modal with target, observed daemon version against this app, and the installation id (short form in layout, full value in title/aria). First connect is trust-on-first-use; a changed installation id is an explicit re-trust; version skew turns the primary action into **Connect anyway**. A `connected` outcome opens `http://127.0.0.1:<localPort>/` in a **new tab** — the same URL the CLI prints — and this tab keeps the badge and its Disconnect. There is no same-tab origin switch.

A refused `remoteControl/list` or `remoteAdmin/status` (LAN-served GUI, loopback-pinned plane) degrades the group to the "remotes are managed on the machine running the app" hint. Removal while a tunnel is live is refused as data so the UI disconnects first.

## Alternatives considered

**Same-tab origin switch after connect.** Rejected: it needs cross-origin `/api` and an Origin-fence exemption for a cross-port loopback caller — a security change for a cosmetic win. The new tab is the tunneled origin; the local tab keeps Disconnect.

**Register remotes inside ui-workspace.** Rejected: remotes are not workspaces, and the region hole belongs to the column shell. `ui-sidebar` declares `sidebar.remotes`; this package fills it.

**Settings → Remotes as the only curator.** Rejected for this change: the sidebar group is the connect path the user asked for. A Settings page that reuses the same store and rows remains a later registration of this package.

**Putting gesture tokens in component props.** Rejected: begin/spend stays inside the apply callbacks so the presentation layer cannot mint, replay, or confuse verb scope.

## Consequences

The collapsed rail renders no remotes affordance — expanding the sidebar is the only route back until a rail seat exists. Tunnels still live with the webapp process; a restart reports `closed`. Disconnect failures currently reuse the trust-modal failed phase. Confirmed-connect through a live ssh forward stays unit-covered; the assembled e2e drives inspect through a hermetic ssh fixture and add/remove through the real registry.

## Testing

Package specs cover the view store, presentational components fed realistic props, and apply (inject face, initial reads, tunnel-state feed, LAN degrade, connect/confirm/add/edit/remove). `ui-sidebar` pins the `sidebar.remotes` hole above the browsing region. The keyless e2e `apps/web/tests/remote-sidebar.e2e.ts` seeds two aliases, snapshots the group, inspects through the ssh fixture into the trust modal, adds a row, and removes it.

## Related

- [remoteAdmin namespace](../architecture/2026-08-30-remote-admin-namespace.md) — the gesture gate, tunnel liveness, and loopback pins this UI drives.
- [Remote-control registry Remote namespace](../architecture/2026-08-29-remote-control-remote-face.md) — read-only `remoteControl/list`; its deferred pin is closed on the host side.
- [Remote control PR1](../architecture/2026-08-29-remote-control-pr1.md) — registry, tunnel contract, CLI.

Does not supersede those notes: they still own the host plane. This note owns the sidebar group, new-tab connected mode, and LAN degraded hint.
