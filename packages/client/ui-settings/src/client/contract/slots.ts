/** Settings contributions shared by feature plugins and the global navigation shell. */

declare module '@shres-code/shres-code-client-ui-slots' {
  interface SlotMap {
    /**
     * The global navigation trigger content: icon + label, supplied as slot
     * content (the accessible name comes from the content — rail state
     * renders the label visually hidden). The shell renders the button
     * chrome and owns open state. Absent contribution degrades to an
     * icon-only button without an accessible name (broken-composition state;
     * the shipped composition always registers the seat).
     */
    'settings.trigger': { kind: 'single'; scope: 'root'; owner: SettingsTriggerOwnerProps }
    /**
     * The settings navigation heading text.
     * Absent contribution leaves the heading empty.
     */
    'settings.header': { kind: 'single'; scope: 'root'; owner: SettingsHeaderOwnerProps }
    /**
     * Optional actions rendered below the active settings section.
     * Registrants own visibility, behavior, copy, and failure presentation;
     * the shell supplies only the ordered render site.
     */
    'settings.action': { kind: 'list'; scope: 'root'; owner: SettingsHeaderOwnerProps }
    /**
     * The close button's visually-hidden label text (the button itself —
     * icon, geometry, focus — is shell chrome). Absent contribution leaves
     * the button without an accessible name (broken-composition state).
     */
    'settings.close': { kind: 'single'; scope: 'root'; owner: SettingsHeaderOwnerProps }
    /**
     * One settings page per list entry. Registrant options carry the nav
     * identity: `id` (section key, drives `only` filtering), `order` (nav
     * position), `label` (registrant-localized display text — the registrant
     * re-registers with fresh text on locale change, so the shell never
     * subscribes locale state; the ledger bump doubles as the shell's
     * re-render trigger). Sections render inside the panel content column.
     */
    'settings.section': { kind: 'list'; scope: 'root'; owner: SettingsSectionOwnerProps }
    /**
     * One page inside the Plugins settings section. The section owner renders
     * localized entry labels as tabs and mounts each contribution inside its
     * corresponding tab panel. Options: `id` (tab key), `order` (tab order),
     * and `label` (registrant-localized tab text). Declared at runtime by the
     * feature that owns the Plugins section; the type lives here so inventory
     * and configuration plugins collaborate without depending on one another.
     */
    'settings.plugins.tab': { kind: 'list'; scope: 'root'; owner: SettingsPluginsTabOwnerProps }
    /**
     * Root-scoped onboarding steps contributed by settings features. The
     * shell mounts one ordered step at a time; the active registrant either
     * completes itself or keeps ownership until the user completes its sole
     * path. Registrants own readiness, copy, dialog behavior, AND visible
     * chrome: a step wraps its visible content in its modal surface (including
     * `#root` inert ownership) and renders null while private facts are still
     * loading. The shell paints no chrome of its own, so a mounted-but-deciding
     * step shows and blocks nothing.
     */
    'settings.onboarding': { kind: 'list'; scope: 'root'; owner: SettingsOnboardingOwnerProps }
    /**
     * One preference row inside the General section — the additive seat for a
     * single setting that needs no page of its own (a whole page is
     * `settings.section`), contributed by the feature plugin that owns the
     * preference (locale → Language, ui-theme → Appearance, ui-conversation →
     * Composer Enter). Options: `id` (row key), `order` (row position). The
     * section column only stacks rows, so a row draws its own internals,
     * including its label: nothing projects a `label` here and the owner passes
     * no props at all — copy, current value, and the write path are all yours,
     * through your own inject face and `host.call`. Declared at runtime by
     * ui-settings-general's General entry; the type lives here with every other
     * settings slot type, because this package is the settings domain's base
     * layer and every registrant already depends on it for `ctx.settingsScope`.
     */
    'settings.general.item': { kind: 'list'; scope: 'root'; owner: SettingsGeneralItemOwnerProps }
    /** Voice preferences rendered above the audio engine configuration. */
    'settings.audio.item': { kind: 'list'; scope: 'root'; owner: SettingsGeneralItemOwnerProps }
  }
}
/** Owner share of a General preference row (the section supplies nothing). */
export interface SettingsGeneralItemOwnerProps {
  /** Marker field: item owner props are intentionally empty. */
  children?: never
}

/** Owner share of a Plugins tab (the section supplies nothing). */
export interface SettingsPluginsTabOwnerProps {
  /** Marker field: tab owner props are intentionally empty. */
  children?: never
}

/** Owner share of the settings trigger content. */
export interface SettingsTriggerOwnerProps {
  /** Whether the trigger displays its text label. */
  wide: boolean
}

/** Owner share of the header title seat (the shell supplies nothing). */
export interface SettingsHeaderOwnerProps {
  /** Marker field: header owner props are intentionally empty. */
  children?: never
}

/**
 * Owner share of a settings section entry. The shell owns page visibility
 * and navigation; a section's data arrives through its own inject faces and
 * stores. `close` and `openSection` are the shell affordances a section
 * receives: `close` for flows that leave settings altogether (starting a
 * session from a section), `openSection` for a link to another page, as the
 * onboarding coordinator's owner share offers.
 */
export interface SettingsSectionOwnerProps {
  /** Return to the workspace. */
  close: () => void
  /** Navigate to another registered section by id; the Settings shell always supplies it. */
  openSection?: (id: string) => void
  /** Optional preference id for a focused view of a contributed item. */
  item?: string
}

/** Owner share of the currently active settings-backed onboarding step. */
export interface SettingsOnboardingOwnerProps {
  /** Stable id of the step currently selected by the coordinator. */
  stepId: string
  /** Complete or skip this step and transfer ownership to the next entry. */
  complete: () => void
  /** Navigate directly to one registered section. */
  openSection: (id: string) => void
}
