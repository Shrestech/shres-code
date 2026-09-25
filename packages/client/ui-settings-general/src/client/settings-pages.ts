/**
 * The `ctx.settingsPages` provider. The settings shell declares `settings.section`,
 * so it owns the check that a link names a registered section before the
 * frame navigates there.
 */

import type { ISettingsPages } from '@shres-code/shres-code-client-ui-settings/client'

/** The `settings.section` ledger facts the provider reads. */
export interface SettingsPageLedger {
  /** Whether the shell has declared `settings.section`. */
  declared(): boolean
  /** Whether a section with this id is registered. */
  has(sectionId: string): boolean
}

/** A call waiting for the `settings.section` declaration. */
interface Waiter {
  readonly sectionId: string
  readonly resolve: () => void
  readonly reject: (error: Error) => void
}

/**
 * Opens Settings at a registered section through the frame's navigation. A
 * call made before the declaration waits; {@link SettingsPages.flush} settles
 * the waiting calls once the declaration and the sections registered with it
 * are on the ledger, and {@link SettingsPages.dispose} rejects them when the
 * face is withdrawn.
 */
export class SettingsPages implements ISettingsPages {
  readonly #ledger: SettingsPageLedger
  readonly #navigate: (page: string) => void
  #waiters: Waiter[] = []

  /**
   * @param ledger - the live `settings.section` ledger.
   * @param navigate - the frame's full-page navigation.
   */
  constructor(ledger: SettingsPageLedger, navigate: (page: string) => void) {
    this.#ledger = ledger
    this.#navigate = navigate
  }

  /**
   * Open Settings at one registered section.
   * @param sectionId - the section's registration id.
   * @returns settles once the frame shows the section.
   */
  async open(sectionId: string): Promise<void> {
    if (!this.#ledger.declared()) {
      await new Promise<void>((resolve, reject) => { this.#waiters.push({ sectionId, resolve, reject }) })
    }
    if (!this.#ledger.has(sectionId)) {
      throw new Error(`settings: no Settings section "${sectionId}" is registered`)
    }
    this.#navigate(sectionId)
  }

  /** Let every waiting call check its id against the now-declared ledger. */
  flush(): void {
    for (const waiter of this.#waiters.splice(0)) waiter.resolve()
  }

  /** Reject every waiting call; the face is being withdrawn. */
  dispose(): void {
    for (const waiter of this.#waiters.splice(0)) {
      waiter.reject(new Error(`settings: the Settings pages face was withdrawn before section "${waiter.sectionId}" opened`))
    }
  }
}
