# Agent Note: remote-connect daemon-port default and uninstalled-remote stage

Status: implemented

## Problem

A connect against `parthm@10.10.8.11` failed with `no host.describe answered on 127.0.0.1:22` - the SSH port sat in the registry entry's daemon-port field, because the web UI's add form offered a free-text "Remote port" with no default while the CLI already defaulted `--port` to 3080, and nothing in the chain re-derived the port. The same remote carried no shres install at all, and the single probe-failure message covered both conditions, telling an uninstalled user to "start the daemon".

## Decision

- `DEFAULT_REMOTE_DAEMON_PORT = 3080` lives in `remote-control/src/types.ts` beside the entries it defaults; `AdminEntryRequest.remotePort` is optional and the gateway's `add`/`edit` resolve `request.remotePort ?? DEFAULT_REMOTE_DAEMON_PORT` explicitly - the defaulting step is the gateway's own resolve, not a hidden fallback in the connect path. The CLI `--port` option consumes the same constant.
- The web UI's add form prefills 3080, submits `undefined` when the field is cleared (so the gateway default applies), and the label names what the field is: the daemon port of `shres web` on the remote.
- After a silent probe loop, `waitForVersion` runs one `installationCheckCommand()` ssh exec (CLI on PATH or a shres home directory) and throws `no-remote-install` when nothing answers; `connect` maps it to the new `unreachable` stage `uninstalled` whose message carries the install command (`npx @shres-code/shres-code web`). An installed-but-silent remote keeps the existing port-naming `probe` stage.
- No registry migration and no rejection of port 22: the schema always required `remotePort`, a root-run daemon on 22 is legal, and persisted user data is not silently rewritten - existing bad entries are fixed by an explicit `remote add <alias> <target> --port 3080` upsert or the UI edit.

## Alternatives considered

- UI-only prefill and label (no wire change): rejected - the 3080 fact would live in two literals and every future wire client would still have to supply a port.
- Hard-rejecting port 22 at write time: rejected - legal configuration, and the loudness now comes from the default, the label, and the discriminated failure.
- Auto-installing the daemon on connect (PR2's ensure-running): deferred by design; the uninstalled stage names the install command instead.

## Consequences

- `AdminEntryRequest.remotePort` is optional on the wire; existing clients sending it are unchanged. The api-remotes client surface widens correspondingly.
- The `unreachable` stage union gained `uninstalled`; UI consumers that switch on stages handle it through their default arm until a dedicated presentation lands.

## Verification

- admin.spec: omitted port resolves to 3080 on add and edit; the uninstalled stage carries the install command; the installed-but-silent case keeps the probe stage.
- controller.spec: exhausted probes on an installed remote stay `probe-failed`; no install marker yields `no-remote-install` with full teardown.
- args.spec: `remote add` without `--port` parses to 3080.
- ui-remote components spec: the add form prefills 3080 and submits the prefilled default; edit keeps the stored port.
- Full remote-control, cli, and ui-remote suites green (194 passed, 1 pre-existing skip).
