/**
 * Loader fixture that holds the Lead's second step until the teammate's
 * settlement notice is admitted.
 * @module team-teammate-fence
 */

import type { Context } from '@shres-code/cordis'
import type {} from '@shres-code/shres-code-agent-loop'
import type {} from '@shres-code/shres-code-subagent'

/** Fixture plugin name. */
export const name = 'team-teammate-fence'

/**
 * Fence the Lead's post-`team_send` request behind admission of the
 * teammate's settlement notice.
 *
 * The Lead's step-2 pre-step starts only after its own `Inbox.claim()` has run.
 * `team_send` does not return until the teammate's initial prompt is durably
 * accepted, and a replayed teammate otherwise runs its whole turn and Activation
 * teardown within the Lead's remaining step-1 work, so its notice would be
 * claimed at step 2. Holding the teammate's second step until the Lead reaches
 * step 2 keeps the notice from being inserted before step 2's claim; the Lead
 * then claims it at step 3, and no second Lead turn opens.
 * @param ctx - assembled headless-agent context.
 */
export function apply(ctx: Context): void {
  const delivered = Promise.withResolvers<undefined>()
  const leadStepTwo = Promise.withResolvers<undefined>()
  let hasDelivered = false
  let hasReachedLeadStepTwo = false

  ctx.effect(() => {
    const disposeInbox = ctx.root.on('agent/inbox/inserted', ({ agent, message }) => {
      if (agent.session.header.parentSession !== undefined || message.source.kind !== 'subagent-settled') return
      hasDelivered = true
      delivered.resolve(undefined)
    })
    const disposeStep = ctx.root.on('agent/pre-step', async ({ agent, turn, step }, next) => {
      if (agent.session.header.parentSession === undefined) {
        if (turn === 1 && step === 2 && !hasReachedLeadStepTwo) {
          hasReachedLeadStepTwo = true
          leadStepTwo.resolve(undefined)
          if (!hasDelivered) await delivered.promise
        }
      } else if (turn === 1 && step === 2 && !hasReachedLeadStepTwo) {
        await leadStepTwo.promise
      }
      return next()
    })
    return () => {
      disposeStep()
      disposeInbox()
    }
  }, 'team-teammate-fence.listeners')
}
