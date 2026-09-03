# Agent Note: Align react-dom with React 19 types

Status: implemented

## Problem

`react` and `@types/react` already sit on 19.2.x. `react-dom` and `@types/react-dom` stayed on 18, so the client program mixed React 18 DOM types with React 19 `useRef` / `RefObject` / `ReactNode` rules. Client `tsc` then rejected zero-argument `useRef`, `RefObject<T>` vs `RefObject<T | null>`, and `ReactElement` vs `ReactNode` across slot tests. VitePress still pulls a React 18 types tree for `@docsearch/react`, so two `@types/react` copies can coexist in the store.

## Decision

Client packages pin `react-dom` `^19.2.8` and `@types/react-dom` `~19.2.5`. `pnpm-workspace.yaml` overrides `@types/react` and `@types/react-dom` to those 19.2.x ranges. Overlay refs that start as `useRef<T>(null)` are typed `RefObject<T | null>` (`useAnchoredMaxHeight`, `WorkspaceChip.buttonRef`, `EmptyWorkspaceOwnerProps.anchorRef`). `JsonTree` passes an initial value to every `useRef`. `Tooltip` reads the child's `ref` from `props` (React 19 no longer stores it on the element). Tests that passed `FC` into `SlotCore.register` use `SlotComponent` instead; testing-library `render(createElement(...))` sites that still see two `ReactNode` copies cast the element. Copy-feedback tests wrap the one-second timer advance in `act` so React 19 flushes the `copied` reset.

## Alternatives considered

**Leave react-dom on 18 after the React 19 bump.** Rejected: the runtime mismatch is the defect, and `@types/react` 19 already makes the 18 `useRef` / `RefObject` APIs invalid in this program.

**Widen `SlotComponent` to `ReactNode | Promise<ReactNode>` so `FC` assigns.** Rejected: React 19 `FC` still adds a nested `Promise<ReactNode>` that is not `Promise<AwaitedReactNode>`. Slot registration keeps the bare call signature; tests stop using `FC`.

**Delete the VitePress React 18 tree.** Rejected: the documentation site's DocSearch dependency is a VitePress concern, not a client-package one. The override pins the client program; VitePress may keep its nested 18 types.

## Consequences

`useRef()` without an initial value is invalid in client code. Overlay `RefObject` props include `null` on `current`. A future VitePress Vite/React bump can drop the leftover 18 types tree without changing this alignment. The documentation site continues to resolve React 18 for DocSearch.
