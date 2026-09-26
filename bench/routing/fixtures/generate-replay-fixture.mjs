/**
 * Regenerates the checked-in replay-labeller fixture through the real product
 * stack: a keyless Context composes the real session store, the real JSONL
 * persistence backend (plain text, unpacked), and the real worker-escalation
 * plugin; a scripted depth-1 worker turn fires the errorBurst trigger, and
 * the product's own write path produces the checked-in log. The checked-in
 * replay-coldpoint-escalation.session.jsonl is that product output verbatim;
 * rerun this script from the repository root to regenerate it.
 *
 * The composed decision carries the default Stage 0 continue (no judgment
 * engine is composed), which is exactly the fired-trigger shape the replay
 * labeller counts: any choice, with the window position taken from
 * data.triggerSeq. No model is called and no credential is read.
 *
 * Run with pnpm run build outputs present: plain Node imports the built
 * lib/ faces, not package sources.
 *
 * @module bench/routing/fixtures/generate-replay-fixture
 */
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const repo = join(here, '..', '..', '..')
const lib = (pkg) => pathToFileURL(join(repo, pkg, 'lib', 'index.js')).href

const { Context } = await import(lib('vendor/cordis'))
const { SessionId, SessionStore } = await import(lib('packages/core/session'))
const { JsonlSessionPersistence } = await import(lib('packages/session/session-persistence-jsonl'))
const { CallId, createToolResultMessage } = await import(lib('packages/llm/llm'))
const workerEscalation = await import(lib('packages/team/worker-escalation'))

const scratch = await mkdtemp(join(tmpdir(), 'bench-replay-fixture-'))
const sessionsRoot = join(scratch, 'sessions')
const ctx = new Context()
try {
  await ctx.plugin(SessionStore, {})
  await ctx.plugin(JsonlSessionPersistence, { root: sessionsRoot, packChunks: false, compression: 'none' })
  await ctx.plugin(workerEscalation, {
    enabled: true,
    progressInstructions: 'Is this worker going to finish without help?',
  })

  const session = ctx.sessions.create(SessionId('bench-replay-coldpoint-escalation'), {
    meta: { cwd: '/tmp/bench-replay-coldpoint', delegationDepth: 1 },
  })

  /** One tool call and its result; errored results drive the error burst. */
  const toolPair = (index, command, ok) => {
    const callId = CallId('call-' + String(index))
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: JSON.stringify({ command }) })
    session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: ok ? 'ok' : 'boom' }], isError: !ok }),
    }, { surfaceOp: 'append' })
  }

  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', {
    content: [{ type: 'text', text: 'Run the failing parser check twice, then fix it.' }],
    source: { kind: 'team-message', form: 'relay', teamId: 'team-lead', messageId: 'assignment-1', senderSessionId: 'bench-lead', senderName: 'lead' },
    role: 'user', id: 'bench-replay-coldpoint-escalation',
  }, { surfaceOp: 'append' })
  // The ladder's cooldown requires two completed steps before any first
  // decision, and the burst counts consecutive errored results across them:
  // step 1 fails once, step 2's failing result completes the burst, and its
  // step/end is the earliest point the decision can land.
  toolPair(1, 'pnpm test -- parser', false)
  session.append('step/end', { turn: 1, step: 1 })
  session.append('step/start', { turn: 1, step: 2 })
  toolPair(2, 'pnpm test -- parser', false)
  session.append('step/end', { turn: 1, step: 2 })
  // The ladder evaluates on a microtask; let the decision land here.
  await new Promise((resolve) => setTimeout(resolve, 0))
  session.append('step/start', { turn: 1, step: 3 })
  toolPair(3, 'git diff --stat', true)
  session.append('step/end', { turn: 1, step: 3 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  await ctx.fiber.dispose()
} finally {
  // Dispose above already flushed; this guard only covers a boot throw.
  await ctx.fiber?.dispose().catch(() => {})
}

const find = async (dir) => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      const hit = await find(path)
      if (hit !== undefined) return hit
    } else if (entry.name === 'session.jsonl') {
      return path
    }
  }
  return undefined
}
const written = await find(sessionsRoot)
if (written === undefined) throw new Error('the product wrote no session.jsonl')
const destination = join(here, 'replay-coldpoint-escalation.session.jsonl')
await cp(written, destination)
await rm(scratch, { recursive: true, force: true })
console.log('fixture regenerated at', destination)
