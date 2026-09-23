#!/usr/bin/env node
/** Snapshot-only driver for manual model selection across persisted resume. */

import assert from 'node:assert/strict'
import type { Context } from '@shres-code/cordis'
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@shres-code/shres-code-app-boot'
import { applyModelSwitch } from '@shres-code/shres-code-agent-default-model'
import { runFixtureTurn } from '@shres-code/shres-code-loader-smoke'
import { SessionId } from '@shres-code/shres-code-session'

const NAME = 'model-router-resume-driver'
const [configPath, flag, promptsJson] = process.argv.slice(2)
if (configPath === undefined || flag !== '--tasks-json' || promptsJson === undefined) {
  throw new Error(`${NAME}: expected <config-path> --tasks-json <prompts>`)
}
const prompts: unknown = JSON.parse(promptsJson)
if (!Array.isArray(prompts) || prompts.length !== 2 || prompts.some(prompt => typeof prompt !== 'string')) {
  throw new Error(`${NAME}: expected two prompts`)
}
const uninstallFailLoud = installFailLoud(NAME)
let ctx: Context | undefined
try {
  loadEnv(NAME)
  ctx = await boot(NAME, resolveConfigPath(configPath, undefined))
  const defaults = ctx.agentDefaultModel
  const original = defaults.currentSelection()
  const sessionId = SessionId('main')
  ctx.on('session/event', (session, event) => {
    if (session.id !== sessionId) return
    process.stdout.write(`${JSON.stringify({ type: 'session_event', sessionId, event })}\n`)
  })
  const first = await ctx.agents.create({
    sessionId,
    meta: { cwd: process.cwd() },
    agentOptions: original,
  })
  await runFixtureTurn(ctx, { task: prompts[0] as string })
  const header = first.agent.session.requestHeader()
  assert.ok(header)
  const selected = { provider: header.config.provider, model: header.config.model }
  assert.notEqual(selected.model, original.model)
  assert.deepEqual(defaults.selectionFor(first.agent).current, original)
  await applyModelSwitch(defaults, first.agent, { kind: 'set', ...selected })
  assert.deepEqual(first.agent.session.requestHeader(), header)
  await defaults.saveSelection(original)
  await ctx.sessions.flush(first.agent.session)
  await first.dispose()

  const resumed = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: original })
  assert.notEqual(resumed.agent, first.agent)
  assert.deepEqual(resumed.agent.session.requestHeader(), header)
  assert.deepEqual(defaults.selectionFor(resumed.agent).current, selected)
  const result = await runFixtureTurn(ctx, { task: prompts[1] as string })
  assert.deepEqual(defaults.selectionFor(resumed.agent).current, selected)
  process.stdout.write(`${JSON.stringify(result)}\n`)
  await resumed.dispose()
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  await ctx?.fiber.dispose()
  uninstallFailLoud()
}
