/**
 * J-Space surface plugin, browser half: the composer chip in
 * `conversation.input.left` and the dock strip in `conversation.input.dock`
 * (order 11, after GoalBar). Visible only while Settings `enabled` is true.
 * Session on/off rides `/j-space on|off` through `command.execute` and
 * never writes the Settings document. Card state arrives through
 * `useProjection('jspace')`.
 */
import type {} from '@shres-code/shres-code-api-remotes/client'
import type { ClientContext, SessionId } from '@shres-code/shres-code-client-runtime/client'
// Type-only: pulls the ui-conversation SlotMap merge (input.left / input.dock).
import type {} from '@shres-code/shres-code-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@shres-code/shres-code-client-locale/client'
// Type-only: pulls ctx.settingsScope.
import type {} from '@shres-code/shres-code-client-ui-settings/client'
// Type-only: the `jspace` SessionProjectionMap merge.
import type {} from '@shres-code/shres-code-jspace/client'
import { JSpaceChip } from './JSpaceChip.tsx'
import { JSpaceDock } from './JSpaceDock.tsx'
import { en, type JSpaceKey } from './locales.ts'
import { JSPACE_SETTINGS_NAMESPACE, type JSpaceSettings } from './settings.ts'
import type { JSpaceChipInjected, JSpaceDockInjected } from './slots.ts'

export type { JSpaceChipInjected, JSpaceDockInjected } from './slots.ts'
export type { JSpaceKey } from './locales.ts'
export type { JSpaceSettings } from './settings.ts'

declare module '@shres-code/shres-code-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The J-Space chip and dock copy. */
    jspace: JSpaceKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'jspace'

/** Required services: slots, commands Remote, locale, and the settings binder. */
export const inject = ['slots', 'remote', 'remote.commands', 'locale', 'settingsScope']

/**
 * Fold a command Remote outcome into the chip's failure line.
 * @param result - `commands.execute` settlement.
 * @param line - dispatched command text, used when admission misses.
 * @returns null on admitted execution; a user-visible failure line otherwise.
 */
function commandFailure(
  result: { ok: true; value: unknown } | { ok: false; error: { message: string; code: string } },
  line: string,
): string | null {
  if (!result.ok) return `${result.error.message} (${result.error.code})`
  if (result.value === undefined) return `unknown command: ${line}`
  return null
}

/**
 * Client plugin body: register the chip and dock over the command channel.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { en }), 'ui-jspace: dictionaries')
  const scope = ctx.settingsScope.bind<JSpaceSettings>({
    namespace: JSPACE_SETTINGS_NAMESPACE,
  })

  const verbs = (sessionId: SessionId): Pick<JSpaceChipInjected, 'closeCard' | 'openCard'> => ({
    closeCard: async () => commandFailure(
      await ctx.remote.commands.execute(sessionId, '/j-space off'),
      '/j-space off',
    ),
    openCard: async () => commandFailure(
      await ctx.remote.commands.execute(sessionId, '/j-space on'),
      '/j-space on',
    ),
  })

  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'jspace',
    order: 0,
    locale: NS,
    inject: (sessionId: SessionId): JSpaceChipInjected => ({
      sessionId,
      hooks: { jspaceSettings: scope },
      ...verbs(sessionId),
    }),
  }, JSpaceChip))

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'jspace',
    order: 11,
    locale: NS,
    inject: (sessionId: SessionId): JSpaceDockInjected => ({
      sessionId,
      hooks: { jspaceSettings: scope },
    }),
  }, JSpaceDock))
}
