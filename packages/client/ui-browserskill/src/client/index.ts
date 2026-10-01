/** BrowserSkill install, control, and teardown contribution to the Plugins page. */

import type {} from '@shres-code/shres-code-client-locale/client'
import type { ClientContext } from '@shres-code/shres-code-client-runtime/client'
import type {} from '@shres-code/shres-code-client-ui-settings/client'
import {
  BrowserSkillSettingsSection,
  BrowserSkillUnavailableError,
  type BrowserSkillSettingsSectionInjected,
} from './BrowserSkillSettingsSection.tsx'
import { en, type BrowserSkillLocaleKey } from './locales.ts'

export type { BrowserSkillSettingsSectionInjected, BrowserSkillSettingsSectionProps } from './BrowserSkillSettingsSection.tsx'
export type { BrowserSkillLocaleKey } from './locales.ts'

declare module '@shres-code/shres-code-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** BrowserSkill install, control, and teardown copy. */
    'settings.browserSkill': BrowserSkillLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.browserSkill'

/** Bundle package name that owns the BrowserSkill host and client rows. */
const BUNDLE_NAME = '@shres-code/shres-code-browser-bundle'

/** Services required by the Settings registration and the generated Remote face. */
export const inject = ['slots', 'locale', 'remote', 'remote.browserSkill']

/**
 * Unwrap one browserSkill receipt. A wire failure throws exactly like the
 * other Settings faces do, keeping transport details out of component state.
 * @param op - the Remote method name, for the thrown error label.
 * @param receipt - the generated receipt promise.
 * @returns the receipt's value.
 */
async function unwrap<T>(
  op: string,
  receipt: Promise<
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
  >,
): Promise<T> {
  const result = await receipt
  if (!result.ok) {
    const message = 'browserSkill.' + op + ' failed: ' + result.error.code + ': ' + result.error.message
    if (result.error.code === 'service-unavailable' || result.error.code === 'method-unavailable') {
      throw new BrowserSkillUnavailableError(message)
    }
    throw new Error(message)
  }
  return result.value
}

/** Contribute BrowserSkill's feature-owned configuration to the shared Plugins manager. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { en }), 'ui-browserskill: dictionaries')

  const face = (): BrowserSkillSettingsSectionInjected => ({
    status: () => unwrap('status', ctx.remote.browserSkill.status()),
    begin: (verb, keepProfile) => unwrap('begin', ctx.remote.browserSkill.begin(
      keepProfile === undefined ? { verb } : { verb, keepProfile },
    )),
    provision: token => unwrap('provision', ctx.remote.browserSkill.provision({ token })),
    openBrowser: token => unwrap('open', ctx.remote.browserSkill.open({ token })),
    closeBrowser: token => unwrap('close', ctx.remote.browserSkill.close({ token })),
    reset: token => unwrap('reset', ctx.remote.browserSkill.reset({ token })),
    uninstall: (token, keepProfile) => unwrap('uninstall', ctx.remote.browserSkill.uninstall({ token, keepProfile })),
  })

  ctx.slots.inject('settings.plugins.bundle', () => ctx.slots.register({
    name: 'settings.plugins.bundle',
    key: BUNDLE_NAME,
    locale: NS,
    inject: face,
  }, BrowserSkillSettingsSection))
}
