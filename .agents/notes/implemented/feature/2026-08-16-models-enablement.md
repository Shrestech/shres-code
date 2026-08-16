# Agent Note: Models page enable switches

Status: implemented

## Problem

The Models list showed every configured or delegated provider with only Edit. Users could not turn a route off without deleting it. CLI cards asked for an API key and an executable, but not the model ids and effort levels the composer picker actually offers, so those stayed out of sync with the route.

## Decision

Each listed provider row has an enable switch that writes `enabled` on that profile (`routes.<id>` for CLI, `providers.<id>` for pi-ai, the section root for DeepSeek). Omitted means on. `enabled: false` keeps the directory entry so the row remains editable, and withdraws the route from the live adapter registry so the picker no longer offers it.

The CLI editor also edits `models` and `efforts` on that same profile. `listModels()` / `resolveModel()` already read those fields, so a save updates the picker. The executable and API key are optional: an empty binary uses the shipped PATH name (`codex`, `claude`, `grok`, `kimi`), and an empty key leaves the CLI's own login in place.

## Alternatives considered

**Loader-level disable.** Rejected: the Plugin list is a read-only Loader projection; Models already owns per-route settings.

**Hide disabled rows.** Rejected: the user could not turn a route back on from this page.

**Probe whether `grok` / `claude` is on PATH to default the switch.** Deferred: composed CLI routes default on; the user can turn one off.

## Consequences

A disabled default model must be re-selected after the route is enabled again. CLI search still uses stored vendor keys independently of this switch. Writing `enabled` (or any other field) on a shipped delegated route materializes its profile in the user layer; those rows stay non-removable because Delete would not take them off the list.
