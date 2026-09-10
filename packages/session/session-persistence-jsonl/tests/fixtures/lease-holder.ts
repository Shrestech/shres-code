/**
 * Two-process lock e2e holder: creates one live session over the given root,
 * materializes two events, prints `holding`, and keeps its kernel write lock
 * until the parent SIGKILLs this process (a crash: release never runs).
 */

import { Context } from '@shres-code/cordis'
import SessionStore, { SessionId } from '@shres-code/shres-code-session'
import JsonlSessionPersistence from '@shres-code/shres-code-session-persistence-jsonl'

const [root, sessionId] = process.argv.slice(2)
if (root === undefined || sessionId === undefined) {
  throw new Error('usage: lease-holder.ts <persistence-root> <session-id>')
}

const ctx = new Context()
await ctx.plugin(SessionStore)
await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
const session = ctx.sessions.create(SessionId(sessionId), { meta: { cwd: '/work' } })
session.append('turn/start', { turn: 1 })
session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
await ctx.sessions.flush(session)
process.stdout.write('holding\n')
// Keep the live session (and with it the kernel lock) until killed; never close.
setInterval(() => {}, 1000)
