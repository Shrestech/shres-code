/**
 * Optional physical carrier a shell provides through the page global
 * `__SHRES_TRANSPORT__`. The served web app omits the global and keeps the
 * HTTP + WebSocket carrier; a shell that owns a different transport (the
 * desktop host's pipe carrier) supplies fetch routing for unary calls and
 * event streams instead.
 */

/** Fetch-compatible carrier for unary calls and streamed event responses. */
export type TransportFetch = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>

/**
 * Transport hooks read once at client boot. `fetch` carries unary RPC and API
 * calls and, for the mux/host downlinks, newline-delimited response bodies.
 * `ownsHost` declares the page owns the Host outright, so the loopback
 * stand-in for the operator's own machine does not apply; only a shell that
 * assembles its own transport can set it, and served pages never carry the
 * global at all.
 */
export interface ClientTransportHooks {
  fetch?: TransportFetch
  ownsHost?: boolean
}

/** Page global carrying {@link ClientTransportHooks}; absent in the served web app. */
export interface ClientTransportGlobal {
  __SHRES_TRANSPORT__?: ClientTransportHooks
}

/**
 * Read the shell-provided transport from the page global.
 * @returns the hooks, or `undefined` when the page owns no transport.
 */
export function readClientTransport(): ClientTransportHooks | undefined {
  return (globalThis as ClientTransportGlobal).__SHRES_TRANSPORT__
}
