# Agent Note: Shield pane counters and Trajectory badges

Status: implemented

## Problem

The Shield Settings page was an on/off form. Trajectory listed every tool call with no verdict. Per-repo counts lived only in the engine's NDJSON, so the pane could not show screened / asked / blocked and a blocked `bash` still looked like a completed call.

## Decision

The host seat keeps `ctx.shield` as `ShieldHost`. The paid plugin must not replace that name. `ShieldHost.snapshot(sessionId?)` is a Typert Remote (`shield/snapshot`) that copies last engine stats for the current session cwd. Stats are not settings and never land in `settings.yaml`. Disable remounts the payload off and still returns last persisted counts with `status.reason === 'disabled'`.

`'shield/decision'` is a `SessionEventMap` member on the seat types face. The body is the W1 decision (`verdict`, `rule`, `reasonCode`, `channel`, `sha16`, optional `host` / `callId` / `origin`) plus optional `turn` / `step` for input-path rows. Writers call `session.append(..., { ignorable: true })`. `SESSION_FORMAT_VERSION` stays `0`.

Settings → Shield stays one page. The existing switch, posture, and license still write the `shres-shield` namespace. The same `ShieldSection` binds `loadSnapshot` and shows this-repo path, four counters, recent findings, and a definition stamp (`—` until the engine reports one).

Trajectory keeps three lanes named Input / Model / Tools. A matching user, context, tool, or subtool row shows Blocked / Asked / Observed. Inspector Summary adds Verdict / Rule / Channel / Host / sha16. Completed / Pending / Failed stay execution state. Multiple decisions on one row keep the highest severity (`deny` > `ask` > `observe`); later equal severity replaces earlier.

## Alternatives considered

**Overwrite `ctx.shield` from the paid plugin.** Rejected: the seat already owns the name for status and the product mark.

**Put counters in the `shres-shield` settings document.** Rejected: increments would remount the engine and persist counts in `settings.yaml`.

**A fourth Trajectory lane or a Security nav item.** Rejected: the ledger is what ran; the pane is the console.

**Bump `SESSION_FORMAT_VERSION` for `shield/decision`.** Rejected: this is vocabulary growth. `ignorable: true` is the skip contract for older readers.

## Consequences

The Client remotes assembly mounts `shield/snapshot`. The Settings plugin injects `remote.shield` and must not import the Host seat package. Trajectory imports `@shres-code/shres-code-shield/types` so `match(event)` sees the merge. The engine still owns the on-disk stats store and `appendDecision`; this change only types the event, exposes a snapshot RPC, and paints the face.

## Testing

Package tests cover the snapshot Remote, disable-keeps-counts, pane empty/disabled/loading/unavailable states, and Trajectory attach for one flagged tool, one flagged user, and one unflagged tool. `gen-persistence-catalog` lists `shield/decision` in `KNOWN_SESSION_EVENT_TYPES`.
