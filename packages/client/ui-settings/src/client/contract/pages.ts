/**
 * The settings-owned face that opens Settings at one section
 * (`ctx.settingsPages`). Settings sections are the only full-page
 * destinations a feature links to, so the settings domain owns their ids: a
 * link names a registered `settings.section` entry, and the provider checks it
 * against the live ledger before it asks the frame to navigate. The frame
 * primitive (`ctx.layout.navigate`) stays generic and is not called with a
 * section id by any feature package.
 */

/** Cross-plugin face that opens Settings at a registered section (`ctx.settingsPages`). */
export interface ISettingsPages {
  /**
   * Open Settings at one registered `settings.section` entry, keeping the
   * workspace and its session mounted underneath. While the settings shell
   * has not declared `settings.section` yet, the call waits for that
   * declaration, and then for the sections that register in the same
   * declaration, before it checks the id.
   * @param sectionId - the section's registration id, such as `model-routing`.
   * @returns settles once the frame shows the section.
   * @throws Error naming the id, as a rejection, when no section with it is
   *   registered once `settings.section` is declared, or when the face is
   *   withdrawn while the call waits.
   */
  open(sectionId: string): Promise<void>
}

declare module '@shres-code/cordis' {
  interface Context {
    /** Opens Settings at a registered section; provided by the settings shell. */
    settingsPages: ISettingsPages
  }
}
