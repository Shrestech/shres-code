/**
 * Goal surface plugin, browser half: the GoalBar entry in the
 * conversation.input.dock strip and the Game mode switch beside the
 * sidebar wordmark. Projection-mode surface — the live goal arrives
 * through `useProjection('goal')`. Game mode arrives through the `game`
 * settings namespace. The inject face carries mutation verbs plus the
 * settings hook. Goal creation stays on the /goal host command.
 */
import type { ClientContext, SessionId } from '@shres-code/shres-code-client-runtime/client'
// Type-only: pulls the generated Remote API and ctx.remote merge through the Client assembly boundary.
import type {} from '@shres-code/shres-code-api-remotes/client'
// Type-only: pulls the ui-conversation SlotMap merge (the input.dock entry).
import type {} from '@shres-code/shres-code-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@shres-code/shres-code-client-locale/client'
// Type-only: the `goal` SessionProjectionMap key merge (single source, the domain's pure outlet).
import type { GoalProjection, GoalRef } from '@shres-code/shres-code-goal/client'
import type {} from '@shres-code/shres-code-client-ui-settings/client'
import type {} from '@shres-code/shres-code-client-ui-sidebar/client'
import type { GoalActionResult, GoalDockInjected, GameModeToggleInjected } from './slots.ts'
import { GoalDock } from './GoalBar.tsx'
import { GameModeToggle } from './GameModeToggle.tsx'
import { GoalCommandInputView } from './GoalCommandInputView.tsx'
import { goalCommandInputDefinition } from './goal-command-input.ts'
import { en, type GoalKey } from './locales.ts'
import { GAME_SETTINGS_NAMESPACE, type GameSettings } from './game-settings.ts'

export { GoalBar, GoalDock } from './GoalBar.tsx'
export type { GoalActionResult, GoalBarActions, GoalDockInjected, GameModeToggleInjected } from './slots.ts'
export type { GoalKey } from './locales.ts'
export type { GameSettings } from './game-settings.ts'

declare module '@shres-code/shres-code-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The goal strip's copy. */
    goal: GoalKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'goal'

/** Required services for the Goal dock, command-input projection, Remote mutations, and copy. */
export const inject = ['slots', 'sessions', 'remote', 'remote.goals', 'locale', 'conversationEvents', 'settingsScope']

/**
 * Client plugin body: the GoalBar dock entry with its mutation verbs.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.conversationEvents.register(goalCommandInputDefinition)
  ctx.effect(() => ctx.locale.register(NS, { en }), 'ui-goal: dictionaries')

  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'command-input',
    locale: NS,
  }, GoalCommandInputView))

  const sessions = ctx.sessions

  /** The session's current projected CAS ref, read at verb call time (no staleness fence: the RPC's CAS is the guard). */
  const refOf = (sessionId: SessionId): GoalRef | undefined => {
    const face = sessions.binding(sessionId)?.session.projections.faceOf('goal')
    const projection = face?.getSnapshot() as GoalProjection | null | undefined
    if (projection == null) return undefined
    return { id: projection.goal.id, revision: projection.goal.revision }
  }

  const noCurrentGoal: GoalActionResult = {
    ok: false,
    error: { code: 'no-current-goal', message: 'no current goal to mutate', details: {} },
  }

  const gameScope = ctx.settingsScope.bind<GameSettings>({
    namespace: GAME_SETTINGS_NAMESPACE,
  })

  ctx.slots.inject('sidebar.brand.action', () => ctx.slots.register({
    name: 'sidebar.brand.action',
    id: 'game-mode',
    order: 0,
    locale: NS,
    inject: (): GameModeToggleInjected => ({
      hooks: { gameSettings: gameScope },
      setEnabled: enabled => gameScope.set('enabled', enabled),
    }),
  }, GameModeToggle))

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'goal',
    order: 10,
    locale: NS,
    inject: (sessionId): GoalDockInjected => ({
      hooks: { gameSettings: gameScope },
      onEdit: async (objective) => {
        const ref = refOf(sessionId)
        if (ref === undefined) return noCurrentGoal
        return await ctx.remote.goals.edit(sessionId, ref, { objective })
      },
      onPause: async () => {
        const ref = refOf(sessionId)
        if (ref === undefined) return noCurrentGoal
        return await ctx.remote.goals.pause(sessionId, ref)
      },
      onResume: async () => {
        const ref = refOf(sessionId)
        if (ref === undefined) return noCurrentGoal
        return await ctx.remote.goals.resume(sessionId, ref)
      },
      onClear: async () => {
        const ref = refOf(sessionId)
        if (ref === undefined) return noCurrentGoal
        return await ctx.remote.goals.clear(sessionId, ref)
      },
    }),
  }, GoalDock))
}
