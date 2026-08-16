# Agent Note: Host-plugin activation approval

Status: implemented

English | [中文](2026-08-16-host-plugin-activation-approval.zh.md)

## Problem

A model-written Host half of a dynamic Cordis Plugin evaluates in the same process as the harness and can reach live services (`ctx.shell`, `ctx.fs`, `ctx.web`). Client-bearing Packages already wait for a person on the page (`cordis/request-run`). Host-only Packages used to start immediately, so privileged code ran with no consent step and no reuse of the existing approval seam.

Unattended compositions (headless snapshots, CI) still need a way to start a known Plugin without an interactive answerer, and a missing or failing answerer must fail closed rather than start Host code.

## Decision

`DynamicCordisRunnerService.activate()` / `startFresh()` asks `ctx.approval` before any Host half is evaluated. The ask is one-shot per Plugin id per Session: `'allowed-once'` sets `plugin.hostActivationApproved` and later Packages or restarts of that Plugin do not ask again. `'allowed-once'` is the only grant; `rejected`, `cancelled`, and `unavailable` refuse before `startHost`. Client-only Packages never ask. Client-bearing Packages still emit `cordis/request-run` and keep the existing page card after the Host-half grant.

The runner injects `approval` so a composition without the seam stays pending at load. Config `hostActivationAllowlist` (default `[]`) lists minted Plugin ids (`<prefix>-<n>`) that skip the ask; an invalid entry fails at plugin load. `cordis_run` returns a structured non-error result for those three denials so the model is told not to retry; the repeat-tool-reminder chain still observes the identical call.

`pnpm run demo:cordis` (Web by default, or `acp`) now prompts through the composed approval answerer before a Host half runs. Unattended replay compositions that must keep the lifecycle green list `snap-1` on the allowlist.

## Alternatives considered

**A second Host-only approval event or panel, separate from `ctx.approval`.** Rejected because the approval seam already owns one-shot grants, audit pairs, `ask`/`never` policy, and ACP/Web answerers. A second path would drift from bash/fs escalation and invent a grant store the seam deliberately does not have.

**Reusing the Client `cordis/request-run` card for Host-only Packages.** Rejected because Host-only Packages have no page to load, headless and ACP deployments never receive that event, and the card is a browser choreography, not a process-privilege grant.

**An `allow-always` or prefix wildcard allowlist.** Rejected because the approval vocabulary has no persistent grant, Plugin ids are minted (`<prefix>-<n>`), and a prefix wildcard would silently cover every later Plugin the model invents. The validated exact-id list is the unattended escape hatch.

**Throwing a tool error on denial.** Rejected because an `isError` result looks transient and invites a retry storm. A structured non-error result states the closed decision; identical retries still advance the repeat-tool-reminder chain.

## Consequences

Host-only activation is no longer silent. Interactive Web and ACP demos ask the user; headless and snapshot compositions that need a Host half to start must either compose an answerer or list the minted Plugin id. Panel `runHostHalf` after the turn has closed fails closed (`unavailable`) rather than starting Host code without an auditable ask. The `cordis` preset skill and `cordis_run` description state that a Host-half denial is final.
