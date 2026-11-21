# Agent Note: BrowserSkill pin freshness and installed-release upgrades

Status: implemented

## Problem

The managed runtime pinned BrowserSkill 0.3.1 while upstream had published 0.5.0, and nothing detected or surfaced the gap. The pin set is the execution authority — a compiled hash, not a saved path — so a stale pin is not a slow download but a shipped build that runs a five-release-old CLI and extension across a protocol change. Worse, the upgrade path lied in two places: `refreshProvisioned` accepted any parseable record as `provisioned`, so an install from an earlier pin reported Ready while every Open refused with `download-failed`, and `status()` reported the compiled version constants instead of the versions actually on disk, under a label that reads "Provisioned artifacts".

## Decision

**The pin is static and its freshness is a release obligation.** `manifest.ts` carries the newest upstream release a Shres build has measured, reviewed and pinned; `pnpm run check:browserskill-pins` compares it with `scripts/browserskill-pin-evidence.json` offline, and a scheduled `--remote` report describes the drift without failing a build. Resolving `releases/latest` at download time is refused: the trust anchor would become whatever upstream published most recently, `version.json` describes the CLI only, and `releases/latest` is a CLI tag while the extension lives at its own `ext-v*` tag — a single latest endpoint does not exist.

**Update is the existing consented verb, not a new one.** `provision` already means "make the pinned release present, then open", already re-downloads when the pinned bytes are absent, and is already consent-gated per call. A record that does not equal this build's pins is the new `outdated` state, carrying the installed and pinned versions and what an update changes: version labels, artifact hashes, and added or removed extension permissions. `open` on an outdated install refuses before the platform and Chrome preflight and before any lease, so the answer never depends on the installed browser and the UI can always offer Update.

**Record format 2 keeps the receipt honest.** A record now stores the extension's `permissions` and `hostPermissions` as they were disclosed. A version-1 record is parseable only to classify it as `outdated`; it is never launched. `status()` reports the recorded versions, and superseded `bsk-v*` directories are collected after the new record commits, under the same lease.

**One release pair is one upgrade unit.** 0.4.1 moved the CLI, daemon and extension to a negotiated protocol and states that mixed versions must not be relied on, so the CLI and extension pins move together and readiness keeps verifying the paired instance. A pin bump also re-measures the wire surface the runner parses, because a changed reply name is not a hash change: [the bump cookbook](../../../../docs/cookbook/browserskill-pin-bump.md) is the procedure, and the 0.5.0 measurement is recorded in `scripts/browserskill-pin-evidence.json`.

## Alternatives considered

**Resolve the latest release at provision time.** Rejected for the reasons above; it would also make the consent disclosure a claim about bytes the build never reviewed, while the runtime's own invariant is that saved hashes are receipts rather than authority.

**A `Config` field for the update channel or for accepting older artifacts.** Rejected: root `AGENTS.md` keeps external specs and security invariants fixed, and a channel knob makes the pin advisory.

**Reject version-1 records outright.** Simpler by a third, but it shows "Set up runtime" to a user who needs "Update", and hides exactly the misreport this note fixes.

**A separate `update` verb.** It would duplicate provision's consent, lease and failure semantics for one presentation difference.

## Consequences

The UI renders Update for an outdated install with the installed-to-pinned versions and the permissions the update adds; declining leaves the old artifacts in place, the browser closed, and the state visible. Package installs are unaffected, and the desktop's owned root is shared with the Web surface, so both see the same state. The lag between an upstream release and a shipped pin is now a stated product obligation rather than an accident: each Shres release ships the newest measured pin, and the scheduled report keeps that visible.

Cross-version daemon recovery still runs the pinned CLI to prove and stop a daemon recorded by an older build, which a protocol-negotiating release can refuse; that recovery should move to pid verification and is the next change here. The 0.5.0 Chrome pairing is measured for the wire surface but not yet re-proved end to end; the consent-and-pair run through **Plugins → BrowserSkill** is the acceptance path.

Evidence: `packages/browser/browserskill/tests/provision.spec.ts` classifies current, version-1, hash-mismatch and permission-delta records and covers collection of superseded directories; `supervisor.spec.ts` reports an outdated install with its installed receipt, refuses open before any spawn or lease, and re-runs provisioning from the stale record; `components.client.spec.tsx` renders Update with the delta and no Open control.
