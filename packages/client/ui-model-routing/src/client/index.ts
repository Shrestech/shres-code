/**
 * Model-routing chip plugin, browser half: occupies the composer's named
 * `conversation.input.modelRouting` seat with the routing toggle. Reads ride
 * the generic projection pair through the standard-kit `useProjection`; the
 * mode is switched by executing /route on or /route off through
 * `command.execute`, so the host stays the single source of routing state and
 * the chip keeps no local copy of it.
 */
import type {} from '@shres-code/shres-code-api-remotes/client'
import type { ClientContext, SessionId } from '@shres-code/shres-code-client-runtime/client'
// Type-only: pulls the ui-conversation SlotMap merge (the input.modelRouting seat).
import type {} from '@shres-code/shres-code-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@shres-code/shres-code-client-locale/client'
// Type-only: pulls the `modelRouting` SessionProjectionMap merge for useProjection.
import type {} from '@shres-code/shres-code-model-router/client'
import { RoutingChip } from './RoutingChip.tsx'
import { en, type RoutingKey } from './locales.ts'

export type { RoutingKey } from './locales.ts'

declare module '@shres-code/shres-code-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The composer routing chip's copy. */
    modelRouting: RoutingKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'modelRouting'

/** Injected business face of the composer routing seat. */
export interface RoutingChipInjected {
  /**
   * Whether this session can switch routing through the command channel; false
   * for addressed subagent sessions, whose Agent-bound commands would activate
   * persisted child history.
   */
  available: boolean
  /**
   * Switch the routing mode by executing /route on or /route off.
   * @param next - the mode to request.
   * @returns null on admitted execution; a user-visible failure line otherwise.
   * Rejects on a transport fault, which the chip surfaces the same way.
   */
  setRouting: (next: boolean) => Promise<string | null>
}

/** Required services: the seat's slot registry, session binding lookup, commands Remote, and locale registry. */
export const inject = ['slots', 'sessions', 'remote', 'remote.commands', 'locale']

/**
 * Client plugin body: register the routing chip over the command channel.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { en }), 'ui-model-routing: dictionaries')

  ctx.slots.inject('conversation.input.modelRouting', () => ctx.slots.register({
    name: 'conversation.input.modelRouting',
    locale: NS,
    inject: (sessionId: SessionId): RoutingChipInjected => ({
      available: ctx.sessions.subagentAddress(sessionId) === undefined,
      // Failure strings stay English (error-surface policy: not localized).
      setRouting: async (next) => {
        const line = next ? '/route on' : '/route off'
        const result = await ctx.remote.commands.execute(sessionId, line)
        if (!result.ok) return `${result.error.message} (${result.error.code})`
        if (result.value === undefined) return `unknown command: ${line}`
        return null
      },
    }),
  }, RoutingChip))
}
