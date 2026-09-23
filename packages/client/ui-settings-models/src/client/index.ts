/**
 * Models settings and product-onboarding plugin, browser half. It registers
 * the Models, Team members, and Voice & audio pages plus the ordered
 * internal-testing and first-run provider onboarding dialogs. The Host
 * settings and credential contracts stay behind their existing wire APIs.
 * Export discipline:
 * packages/client/AGENTS.md.
 */
import type { ClientContext } from '@shres-code/shres-code-client-runtime/client'
import type { ConnectionHandle } from '@shres-code/shres-code-api-remotes/client'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@shres-code/shres-code-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@shres-code/shres-code-client-locale/client'
// Type-only: pulls the ctx.remote merge and the forwarded-event key face
// (settings/credentials invalidations ride the allowlist) into this program.
import type {} from '@shres-code/shres-code-api-remotes/client'
import { ModelsSection } from './ModelsSection.tsx'
import type { ModelsSectionInjected } from './ModelsSection.tsx'
import { TeamSection } from './TeamSection.tsx'
import type { TeamSectionInjected } from './TeamSection.tsx'
import { AudioSection } from './AudioSection.tsx'
import type { AudioSectionInjected } from './AudioSection.tsx'
import type { SpeechStatusFace } from './SpeechAudioCard.tsx'
import { FirstRunOnboardingDialog } from './FirstRunOnboardingDialog.tsx'
import type { FirstRunOnboardingInjected } from './FirstRunOnboardingDialog.tsx'
import { WelcomeNotice } from './WelcomeNotice.tsx'
import type { WelcomeNoticeInjected } from './WelcomeNotice.tsx'
import { refreshWelcomeIfLoaded, WelcomeNoticeStore } from './welcome-store.ts'
import { ModelsSettingsStore } from './store.ts'
import { en, type ModelsKey } from './locales.ts'
import { WELCOME_NOTICE_SETTINGS_NAMESPACE } from '../onboarding-copy.ts'

export type { ModelsSectionInjected, ModelsSectionProps } from './ModelsSection.tsx'
export type { TeamSectionInjected, TeamSectionProps } from './TeamSection.tsx'
export type { AudioSectionInjected, AudioSectionProps } from './AudioSection.tsx'
export type { ModelsKey } from './locales.ts'

declare module '@shres-code/shres-code-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Models page + product-onboarding copy. */
    'settings.models': ModelsKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.models'
export type { ModelsSettingsState, ProviderRow } from './store.ts'

/**
 * Refetch the page snapshot only after its first load: an unopened Models
 * page must not fetch on background invalidations.
 * @param controller - the page store.
 */
export function refreshIfLoaded(controller: ModelsSettingsStore): void {
  if (controller.store.getSnapshot().status === 'idle') return
  void controller.load()
}

/**
 * Required services (cordis fiber inject). The target slot is declared by
 * ui-settings' apply, whose activation order relative to this one is NOT
 * constrained; registration depends on each slot through `slots.inject()`.
 * `remote.speech` names the typert remote namespace the Audio page reads;
 * api-remotes contributes it wherever this plugin is composed.
 */
export const inject = ['slots', 'locale', 'connection', 'remote', 'remote.speech']

/**
 * Register the settings sections once the `settings.section` declaration is on
 * the ledger, wire their shared store to the connection, and keep it fresh on
 * every pushed invalidation (settings, credentials, or provider topology).
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { en }), 'ui-settings-models: copy dictionaries')

  const connection = ctx.get('connection') as ConnectionHandle
  const controller = new ModelsSettingsStore(connection.api)
  // Registration-time text (the nav label thunk) and the inject faces share
  // one bound translate; copy freshness rides the locale revision.
  const t = ctx.locale.bind(NS) as ModelsSectionInjected['t']
  // The speech Remote mounts with the typert remote namespace; absent (a
  // browser without the speech package) the Audio page degrades to the
  // stored section alone.
  const speech: SpeechStatusFace | undefined = (ctx.remote as { speech?: SpeechStatusFace }).speech
  const sharedSettingsInjected = (): ModelsSectionInjected & TeamSectionInjected => ({
    controller,
    hooks: { snapshot: controller.store },
    api: connection.api,
    t,
  })
  const audioInjected = (): AudioSectionInjected => ({
    controller,
    hooks: { snapshot: controller.store },
    api: connection.api,
    t,
    ...speech === undefined ? {} : { speech },
  })
  const firstRunOnboardingInjected = (): FirstRunOnboardingInjected => ({
    controller,
    hooks: { models: controller.store },
    api: connection.api,
    t,
  })
  const welcomeController = new WelcomeNoticeStore(
    connection.api,
    connection.isLoopback ? 'host' : 'memory',
  )
  const welcomeInjected = (): WelcomeNoticeInjected => ({
    controller: welcomeController,
    hooks: { welcome: welcomeController.store },
    t,
  })

  // Pushed invalidations converge every open surface without polling: any
  // settings/credentials/topology change refetches once the page loaded.
  ctx.effect(() => {
    const refreshModels = (): void => { refreshIfLoaded(controller) }
    const refreshAll = (): void => {
      refreshModels()
      refreshWelcomeIfLoaded(welcomeController)
    }
    const disposers = [
      ctx.remote.$on('settings/document-updated', (ns) => {
        refreshModels()
        if (ns === WELCOME_NOTICE_SETTINGS_NAMESPACE) refreshWelcomeIfLoaded(welcomeController)
      }),
      ctx.remote.$on('credentials/updated', refreshModels),
      ctx.remote.$on('llm/adapters-updated', refreshModels),
      ctx.on('connection/reset', refreshAll),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'ui-settings-models: pushed invalidations')

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'models',
    order: 10,
    label: () => t('nav'),
    inject: sharedSettingsInjected,
  }, ModelsSection))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'teams',
    order: 11,
    label: () => t('teamsNav'),
    inject: sharedSettingsInjected,
  }, TeamSection))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'audio',
    order: 14,
    label: () => t('audioNav'),
    children: {
      'settings.audio.item': { kind: 'list', scope: 'root' },
    },
    inject: audioInjected,
  }, AudioSection))
  ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
    name: 'settings.onboarding',
    id: 'welcome-notice',
    order: -100,
    inject: welcomeInjected,
  }, WelcomeNotice))
  ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
    name: 'settings.onboarding',
    id: 'first-run',
    order: 0,
    inject: firstRunOnboardingInjected,
  }, FirstRunOnboardingDialog))
}
