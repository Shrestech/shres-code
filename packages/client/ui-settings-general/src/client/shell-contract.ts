/** Global navigation props and live settings-section projections. */
import type { HostObservable, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@shres-code/shres-code-client-ui-slots'
// Type-only: pulls ui-layout's SlotMap merge (the 'shell.navigation' entry)
// into every program that sees this contract.
import type {} from '@shres-code/shres-code-client-ui-layout/client'
// Type-only: pulls the settings slot declarations the shell renders into.
import type {} from '@shres-code/shres-code-client-ui-settings/client'

/** One nav row projected from a settings.section registration's options. */
export interface SettingsSectionRow {
  id: string
  order: number
  label: string
}

/** One ordered onboarding step projected from a slot registration. */
export interface SettingsOnboardingStep {
  id: string
  order: number
}

/**
 * Registrant-private injected share of the settings shell (assembled in
 * apply): the ledger's nav-row projection as a hooks-compartment source —
 * the shell reads no locale state and subscribes through the bound hook.
 */
export type SettingsRootInjected = {
  hooks: {
    /** settings.section ledger projected into ordered nav rows. */
    sections: HostObservable<readonly SettingsSectionRow[]>
    /** settings.onboarding ledger projected into coordinator order. */
    onboardingSteps: HostObservable<readonly SettingsOnboardingStep[]>
  }
}

/** Frame-owned navigation, contributed sections, and localized shell copy. */
export type SettingsRootComponentProps =
  PropsRuntime<'shell.navigation'>
  & PropsRenderSlots<
    | 'settings.trigger'
    | 'settings.header'
    | 'settings.action'
    | 'settings.close'
    | 'settings.section'
    | 'settings.onboarding'
  >
  & InjectFace<SettingsRootInjected> & PropsLocale<'settings'>
