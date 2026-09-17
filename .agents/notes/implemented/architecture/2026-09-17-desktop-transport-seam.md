# Agent Note: Client transport seam for shell-owned carriers

Status: implemented

## Problem

The desktop host child process carries API traffic over framed byte pipes instead of a listening socket, so its page cannot use the browser carrier (HTTP fetch plus downlink-only WebSockets). Upstream solved this with a webserver `index-inject` event plus a larger `ClientTransportHooks` surface (`rpc`, `fetch`, `openStream`, `loadBundle`, `ownsHost`) wired through a redesigned generation-source connection loop.

## Decision

`client/connection` reads a page global `__SHRES_TRANSPORT__` once at boot. The hooks carry exactly what the desktop uses: `fetch` (a fetch-compatible carrier for unary RPC and API calls) and `ownsHost` (the transport owner declares the page owns the Host outright, so `connection.isLoopback` is true regardless of page authority). When a transport is present, `WebApiClient` routes `doFetch` through the carrier and replaces each downlink WebSocket with a newline-delimited streaming response body on the same path (`POST`, `accept: application/x-ndjson`); each line is a `ServerRequest` envelope, malformed lines drop with a console error, and body end is stream loss exactly like a socket close. Without the global, served-web behavior is unchanged: HTTP fetch, WebSockets, page-authority loopback. `createWebConnectionRpc` takes the same carrier for generic unary channels. The Typert gateway needs no separate stream carrier: its Remote endpoints already ride the `/api` route through the registered interceptor, so the desktop host serves them over the same fetch dispatch.

## Alternatives considered

**Port the upstream webserver `index-inject` event.** Rejected: in this tree the event would have exactly one consumer (the desktop host), which the single-consumer rule rejects; the desktop host instead calls `injectBootManifest` and prepends the transport script itself.

**Port the full upstream hook surface (`rpc`, `openStream`, `loadBundle`).** Rejected: no consumer exists for those members here; the seam grows when a consumer arrives.

**Override `globalThis.fetch` from the injected script.** Rejected: an implicit page-wide monkey patch hides the carrier from every unrelated consumer and cannot express `ownsHost`.

## Consequences

Served-web pages are byte-identical in behavior (snapshot- and suite-guarded). A shell that owns its transport gets unary routing, ndjson event downlinks, and loopback authority through one explicit global. The ndjson downlink contract (same paths, `POST`, one envelope per line) is the desktop host's server-side obligation. Adding a gateway stream carrier later extends `ClientTransportHooks` and updates this note.
