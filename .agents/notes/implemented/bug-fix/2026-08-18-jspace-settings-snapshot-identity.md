# Agent Note: J-Space Settings snapshot identity

Status: implemented

## Problem

Settings → J-Space binds the selected session's `jspace` projection through `bindSnapshotSelector` / `useSyncExternalStoreWithSelector`. `foldJSpaceCardView` allocated a new `{ open, checked }` object on every read of a present card or tombstone. React treats a new `getSnapshot()` return as a store change, so the Settings slot re-rendered until it hit the maximum update depth. The section error boundary then rendered an empty pane: the nav row highlighted and the form (Activate switch, mode, requireCoverage, session console) was missing.

The first paint without a selected session returned `undefined` and stayed stable, so the keyless e2e that opened Settings before adding a workspace did not see the crash.

## Decision

`foldJSpaceCardView` returns the previous `JSpaceCardView` object when `open` and `checked` already match. `createJSpaceViewSource.getSnapshot` therefore keeps the same reference until those fields change. The Settings page still reads last-known counts from the projection; only the object identity is stable.

## Alternatives considered

**Compare selected values in `useCard` instead of stabilizing the source.** Rejected: `JSpaceSection` selects the whole view (`useCard(current => current)`), and `bindSnapshotSelector` uses React's default `Object.is`. A new object still loops. A custom equality function would hide the source contract every other subscriber must also satisfy.

**Cache inside `createJSpaceViewSource.getSnapshot` only.** Rejected: `readJSpaceView` and `foldJSpaceCardView` are the allocators. Stabilizing only the source would leave those helpers allocating on every call and invite a later reader to bind them directly.

## Consequences

Opening Settings → J-Space with a selected session shows the form. A later card or tombstone that changes `open` or `checked` still produces a new object and notifies subscribers. Package specs pin fold and `getSnapshot` identity. The assembled Settings e2e re-opens the pane after a workspace session exists.

## Related

The Settings remount and page inventory live in [J-Space as a Settings-toggled harness card](../feature/2026-08-18-jspace-settings-toggle.md).
