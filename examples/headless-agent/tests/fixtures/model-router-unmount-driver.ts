#!/usr/bin/env node
/**
 * Snapshot-only driver for a routed session resumed in a tree without the
 * router: the first boot routes one turn with no front-end selection, and the
 * second boot, whose configuration leaves the router entry disabled, resumes
 * the persisted session, restores its selection as the headless bundle does,
 * and runs the second turn.
 */

import assert from 'node:assert/strict'
import type { Context } from '@shres-code/cordis'
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@shres-code/shres-code-app-boot'
import { runFixtureTurn } from '@shres-code/shres-code-loader-smoke'
import { SessionId } from '@shres-code/shres-code-session'

const NAME = 'model-router-unmount-driver'
/** Environment switch the arm's configuration reads to leave the router entry disabled. */
const ROUTER_REMOVED_ENV = 'SHRES_SNAPSHOT_ROUTER_REMOVED'
const [configPath, flag, promptsJson] = process.argv.slice(2)
if (configPath === undefined || flag !== '--tasks-json' || promptsJson === undefined) {
  throw new Error(`${NAME}: expected <config-path> --tasks-json <prompts>`)
}
const prompts: unknown = JSON.parse(promptsJson)
if (!Array.isArray(prompts) || prompts.length !== 2 || prompts.some(prompt => typeof prompt !== 'string')) {
  throw new Error(`${NAME}: expected two prompts`)
}
const sessionId = SessionId('main')

/** Stream this session's events from one booted tree. */
function forward(ctx: Context): void {
  ctx.on('session/event', (session, event) => {
    if (session.id !== sessionId) return
    process.stdout.write(`${JSON.stringify({ type: 'session_event', sessionId, event })}\n`)
  })
}

const uninstallFailLoud = installFailLoud(NAME)
let ctx: Context | undefined
try {
  loadEnv(NAME)
  const configFile = resolveConfigPath(configPath, undefined)
  ctx = await boot(NAME, configFile)
  forward(ctx)
  const original = ctx.agentDefaultModel.currentSelection()
  const first = await ctx.agents.create({ sessionId, meta: { cwd: process.cwd() }, agentOptions: original })
  await runFixtureTurn(ctx, { task: prompts[0] as string })
  const routed = first.agent.session.requestHeader()
  assert.ok(routed)
  assert.notEqual(routed.config.model, original.model)
  await ctx.sessions.flush(first.agent.session)
  await first.dispose()
  await ctx.fiber.dispose()

  process.env[ROUTER_REMOVED_ENV] = '1'
  ctx = await boot(NAME, configFile)
  assert.equal(ctx.get('modelRouting'), undefined)
  forward(ctx)
  const resumed = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: original })
  assert.deepEqual(resumed.agent.session.requestHeader(), routed)
  // The front end restores the session's selection, which is the manual route
  // recorded beneath the routed header rather than the candidate that header runs.
  assert.deepEqual(ctx.agentDefaultModel.selectionFor(resumed.agent).current, original)
  const result = await runFixtureTurn(ctx, { task: prompts[1] as string })
  assert.equal(resumed.agent.session.requestHeader()?.config.model, original.model)
  process.stdout.write(`${JSON.stringify(result)}\n`)
  await resumed.dispose()
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  await ctx?.fiber.dispose()
  uninstallFailLoud()
}
