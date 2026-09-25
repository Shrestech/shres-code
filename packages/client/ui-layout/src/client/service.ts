/**
 * LayoutController: the cross-plugin panel-action face behind ctx.layout.
 * Panel geometry itself lives in the root entry's layout store (stores.ts);
 * the current-session selection lives with the runtime sessions service, and
 * the per-session active view dissolved into ui-conversation's session store
 * (its only consumer). What remains here is the contract other plugins'
 * apply worlds reach for panel transitions (sidebar toggle from ui-sidebar,
 * details open/close from ui-conversation) and the full-page destination
 * primitive — writes stay inside the store's declared action set, delivered
 * as the registration's bound actions.
 */
import type { BoundActions } from '@shres-code/shres-code-client-ui-slots'
import type { createLayoutStore } from './stores.ts'

/** The layout store's bound action set (framework-baked, draft params peeled). */
export type PanelActions = BoundActions<ReturnType<typeof createLayoutStore>>

/**
 * The outward layout face (`ctx.layout`): the panel transitions other
 * plugins may trigger — and exactly what a test fake must supply. The
 * attachPanels wiring hook stays on the concrete class (root-entry assembly
 * only).
 */
export interface ILayout {
  /** Toggle the sidebar panel (closed ⟷ contract default width). */
  toggleSidebar(): void
  /** Open the details panel (no-op when already open). */
  openDetails(): void
  /** Close the details panel. */
  closeDetails(): void
  /**
   * Show a full-page destination above the workspace, keeping the mounted
   * session and its draft, or return to the workspace. The frame does not
   * interpret the id: it is a full-page destination id owned by the
   * destination's provider, which checks it before calling this (Settings
   * sections open through `ctx.settingsPages.open`). A call made before the
   * frame first renders is recorded, the latest one winning, and applied once
   * it renders, so callers need not know the frame's mount order.
   * @param page - the full-page destination id, or null for the workspace.
   */
  navigate(page: string | null): void
}

/**
 * Cross-plugin panel-action face (ctx.layout). The panel actions fail loud
 * before the root entry renders; a full-page destination requested before
 * then is recorded and applied once the entry attaches its actions.
 */
export class LayoutController implements ILayout {
  #panels: PanelActions | undefined
  /** The latest destination requested before the root entry attached, if any. */
  #pending: string | undefined
  /** Counts navigate calls, so a recorded destination never overrides a later request. */
  #requests = 0

  /**
   * Adopt the root entry's bound store actions. Called from the root
   * registration's inject hook (a sanctioned assembly side effect), so the
   * face is live from the entry's first render; on entry re-register the
   * fresh actions overwrite the stale set. A destination recorded before the
   * first attach is applied in a microtask, after the render that attached,
   * unless another navigate call came first.
   * @param actions - bound actions of the entry's layout store instance.
   */
  attachPanels(actions: PanelActions): void {
    this.#panels = actions
    const pending = this.#pending
    if (pending === undefined) return
    this.#pending = undefined
    const request = this.#requests
    queueMicrotask(() => {
      if (this.#requests === request) this.#panels?.navigate(pending)
    })
  }

  /** Toggle the sidebar panel (closed ⟷ contract default width). */
  toggleSidebar(): void {
    this.#require().toggleSidebar()
  }

  /** Open the details panel (no-op when already open). */
  openDetails(): void {
    this.#require().openDetails()
  }

  /** Close the details panel. */
  closeDetails(): void {
    this.#require().closeDetails()
  }

  /**
   * Show a full-page destination above the workspace, or return to it.
   * Before the root entry attached, the latest request is recorded (null
   * clears it) and applied on attach.
   * @param page - the full-page destination id, owned by the destination's provider, or null for the workspace.
   */
  navigate(page: string | null): void {
    this.#requests += 1
    const panels = this.#panels
    if (panels === undefined) {
      this.#pending = page ?? undefined
      return
    }
    panels.navigate(page)
  }

  #require(): PanelActions {
    // Callers are UI gestures, which cannot fire before the root entry
    // rendered (the inject hook runs in its first render) — reaching this
    // unwired is a boot-order bug, not a race to tolerate.
    if (this.#panels === undefined) throw new Error('layout: panel actions not wired (root entry not mounted)')
    return this.#panels
  }
}
