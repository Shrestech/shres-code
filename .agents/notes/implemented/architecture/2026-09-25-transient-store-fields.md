# Agent Note: Field-granular transient store state

Status: implemented

## Problem

A persisted store declaration (`defineStore({ init, persist, actions })`) writes its whole state to localStorage on every change and restores it on the next page load. Some fields of such a state are viewing state for one page load: the chat store's Activity popover being open is the case that raised it, where a reload rendered the popover open for a frame before a guard closed it. The same gesture writes that field together with fields that must persist: a view's `reveal()` sets the chat view and the inspect handoff and closes the popover in one action.

## Decision

`StoreSpec` in [ui-slots](../../../../packages/client/ui-slots/README.md) gains `transient?: readonly (keyof T & string)[]`, and the runtime engine (`createSnapshotStore`, `defineStore`) honours it. Persistence strips the listed top-level fields from every write and restores them from `init()` on every read, including from a value written before the field was transient, so a page load starts them fresh. Only top-level fields of an object state can be named. The declaration fails loud, naming the field, when a listed field is not an own top-level field of `init()` (a typo, a nested path, or a primitive state), and `defineStore` rejects a transient list without `persist`, where it would mean nothing. The type admits only the state's string keys, so a typo is a compile error first.

## Alternatives considered

**Split the state into a persisted store and a transient one.** A registration declares exactly one store, and an action writes one draft, so a gesture that writes both kinds of field, such as `reveal()` writing the view, the inspect handoff, and the popover's open state, would need a second store seat or a cross-store write path, both new framework surface, to express one fact about one field.

**Validate the restored value field by field in the consumer.** The chat store did this with a guard function that read only a stored `true` as open; every consumer would repeat it for every such field, and the value would still be written and restored for a frame.

**Keep the state in component-local React state.** It never persists, but a view cannot reach it through the store's actions, which is how another view closes the popover.

## Consequences

- A store can mix persisted and per-page-load fields without a guard, and a reload never shows a transient field's last value.
- At this base the chat store keeps the Activity popover's open state in component state; the change that moves it into the chat store declares it transient.
- Nested transient paths are not supported; a declaration that needs one names the top-level field that holds it.
