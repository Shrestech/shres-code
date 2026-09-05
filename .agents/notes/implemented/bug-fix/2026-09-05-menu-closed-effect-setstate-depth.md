# Agent Note: Closed Menu effects must not setState per parent render

Status: implemented

## Problem

The workspace sidebar crashed with minified React error #185 (maximum update depth exceeded) inside the `sidebar.workspaces` slot, with the throw attributed to `Menu.tsx`'s closed-path `setOpenSubmenuId(null)`. Every session and workspace row mounts a portal `Menu` that owners close with a fresh `onClose={() => setMenuOpen(false)}` closure each render. The outside-click effect listed `onClose` as a dependency, so a parent render re-ran it on every closed menu and scheduled that setState. A list of those menus in one commit exceeds React's nested-update limit. The same pattern would re-place an open portal list whenever `getAnchorRect` was an inline closure.

## Decision

`Menu` reads `onClose` and `getAnchorRect` from refs. The listener/reset effect and the portal placement effect key only on `open` (plus placement geometry), not on those callback identities. Closed-path `setState` uses a same-value updater so an already-null submenu id or placement does not schedule work. Open portal placement also keeps the previous `{ left, top }` object when the numbers have not changed, so a capture-phase scroll during layout cannot feed a new-object setState loop. `HoverCard` uses the same same-value placement updaters because every session row mounts one beside its menu.

## Alternatives considered

**Ask every owner to `useCallback` their `onClose`.** Rejected: inline close closures are the normal call site (`Rows`, `ViewOptionsMenu`, `WorkspacePickFlow`), and the atom is the one that can stop scheduling from them.

**Keep `onClose` in the effect deps and only skip `setOpenSubmenuId` when already null.** Rejected: that still tears down and rebinds document listeners on every parent render, and a React version that does not eager-bailout the same-value update would still count each menu toward the nested-update limit.

**Raise the nested-update limit or catch #185 in the slot error boundary and ignore it.** Rejected: the boundary already reports the crash; swallowing it would hide a real update loop.

## Consequences

A workspace list can re-render (session timestamps, snapshot updates) without each closed row menu scheduling an update. Escape and outside click still invoke the latest `onClose`. An owner-driven close still disarms a pending pointer-grace timer, now in the same `open`-keyed effect that used to re-run on `onClose` identity — the split existed only to avoid that re-run.

## Testing

`packages/client/ui-primitives/tests/atoms.client.spec.tsx` renders 60 closed portal menus through five parent renders that each pass a new `onClose`, and asserts Escape/outside click after a replacement `onClose` call the latest closure. Existing Menu portal, grace, and submenu specs still cover open-path placement and dismissal.
