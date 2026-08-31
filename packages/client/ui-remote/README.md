# @shres-code/shres-code-client-ui-remote

The remote-connect group for the web GUI: one `RemotesSection` registered into the sidebar shell's `sidebar.remotes` hole. The group renders a fold header, one row per durable remote alias (alias, `user@host` target, live status dot), the inline add/edit form, a connected badge for every open tunnel, and the first-connect trust modal. Every mutation rides the gesture-gated `remoteAdmin` namespace (`begin` → spend), registry reads ride the read-only `remoteControl` namespace, and tunnel liveness arrives as the forwarded `remote-control/tunnel-state` event; the apply closure mirrors all of it into one observable view store that the section reads through the inject `hooks` compartment.

Connecting is a two-step conversation. A row click runs `inspect` and opens the trust modal with the remote's facts: target, observed daemon version against this app's, and the installation id (short form in layout, full value in title/aria). A first connect shows the trust-on-first-use decision; a changed installation id shows the explicit re-trust warning; a version skew turns the primary action into **Connect anyway**. Confirming mints one gesture grant and spends it on `connect`; a `connected` outcome opens the tunneled origin `http://127.0.0.1:<localPort>` in a NEW browser tab (the same URL the CLI prints) — this tab keeps the badge and its **Disconnect**, so there is no same-tab origin switch and no cross-origin carrier traffic. Unreachable outcomes render as a retryable failure; decision outcomes re-enter the modal carrying the data the second decision needs.

The apply closures own the complete mutation face handed to the section: connect/confirm/cancel, disconnect, add/edit (with inline wire-failure display), and remove — removal is refused while the alias has a live tunnel, and the row surfaces the "disconnect first" refusal. A refused `remoteControl/list` or `remoteAdmin/status` (a LAN-served GUI, where the whole plane is loopback-pinned) degrades the group to the "remotes are managed on the machine running the app" hint. A committed tunnel transition reconciles the status dot same-tick from the pushed full-state view; an `open` also re-reads the registry because a verified connect stamps `lastConnectedAt` and the fingerprint. A connection reset resyncs both mirrors, matching the carrier's full-rebuild reconnect.

Both target holes are declared by other plugins, so `apply` uses `slots.inject()` to register for the declaration lifetime.

## Model Experience

None, as the group is browser chrome; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **The collapsed rail renders no remotes affordance** — with the sidebar folded, the workspaces region owns the 56px column and the group renders nothing; expanding the sidebar is the only route back. A rail seat is deferred until the column's icon budget is settled.
- **Tunnels live with the webapp process** — the tunnel handles belong to the serving `remoteAdmin` gateway, so a webapp restart ends GUI-opened tunnels and the status honestly reports `closed`; cross-process adoption of the PID markers is deferred.
- **Disconnect failures surface in the trust modal** — the badge's disconnect is the only control without its own error surface, so a wire failure there opens the failed phase over the group.
- **The Settings → Remotes curation page is a later PR** — it reuses this package's view store and row components from the same apply closure.
