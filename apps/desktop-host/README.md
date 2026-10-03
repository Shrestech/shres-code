# shres-desktop-host

Private Node-mode host process for the Shres desktop application. The Electron
shell spawns this child instead of opening a listening socket: it boots the
installed desktop project and carries every request — the `/api` surface, the
client bundles, and the built frontend — over framed byte pipes (fds 3/4) that
the shell's `shres-app://` handler forwards into.

## Composition

`runDesktopHost(runtimeDir, projectDir, writeResponse, options)` writes the project's composition root, loads the project profile with `loadProfileDirectory` (the desktop owns profile creation — no template auto-init), and layers the shipped `config/desktop.cordis.patch.yml` over the base + web-app bundle rows: `web-startup`, `webserver`, `web-runtime`, and `client-hmr` are disabled. The host provides no-op `webServer` metadata so the client node halves can register and dispose without binding a socket, then owns `/api` dispatch through the connection service or its `HostConnectionService` fallback. The native directory-picker pair is inserted in place of the bind-dependent auto picker. The profile's listed bundles must resolve inside the runtime or project trees unless the development launch option allows linked packages.

The executable entrypoint calls `healProfilesModuleFallback` with the installed `@shres-code/shres-code-desktop-host/package.json` before it opens the pipes. That links the installed dependency closure under `$SHRES_HOME/profiles/node_modules` for the profile's Node parent walk. Exported `runDesktopHost` remains an explicit API and does not heal or mutate that home fallback.

## Dispatch

- `/api/*` — the host owns the shared handler directly (`HostConnectionService`
  with the loopback pin unset: the pipes are single-user dispatch, not a
  socket). The Typert interceptor claims its Remote endpoints before the API
  Proxy fallback; POST on `/api/events.mux` and `/api/events.host` answers the
  browser's fetch-stream downlinks — one server-request envelope per ndjson
  line, body end meaning stream loss, mirroring the WebSocket carrier the
  desktop page cannot open.
- `/plugins/<id>/client.js[.map]` — `clientModules.fetchBundle`.
- everything else — the built frontend dist, with `injectBootManifest` into
  the index plus the `__SHRES_TRANSPORT__` script (the client transport seam:
  its presence flips the browser carrier to fetch-stream downlinks and grants
  loopback authority via `ownsHost`), decode-then-contain path checks, and the
  SPA fallback for unknown assets.

## Wire protocol

`wire.ts` frames requests and responses (magic `0x53485233`, protocol version
1, 64 KiB data chunks, monotonic stream ids). The process entry reads fds 3/4.
An unread request body pauses the request pipe. Event downlinks coalesce a few
milliseconds of NDJSON, or 16 KiB, into one body chunk and wait when that
stream's own queue is full. The shell pauses the shared response pipe only
after it is already holding 2 MiB of unread response bytes, so one event
stream does not stall other responses. The entry emits `ready`/`fatal` over
Node IPC and tears down on `shutdown`, parent disconnect, or pipe errors.

## Testing

`tests/wire.spec.ts` covers frame encode/decode, bounds, and error paths;
`tests/desktop-host.spec.ts` boots the host against a fixture runtime project
and asserts the routes above over decoded response frames. A real desktop
profile installs the two inserted picker packages; the fixture stages them as
no-op plugins.
