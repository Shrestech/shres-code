#!/usr/bin/env node
/**
 * Snapshot-only driver for a manual model switch inside one live session: it
 * runs the first prompt, selects the model that turn's request header ran on
 * the same agent, and runs every remaining prompt on it. No dispose or resume
 * separates the turns, so the log carries no `session/end-seed` between them.
 */

import assert from 'node:assert/strict'
import type { Context } from '@shres-code/cordis'
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@shres-code/shres-code-app-boot'
import { applyModelSwitch } from '@shres-code/shres-code-agent-default-model'
import { runFixtureTurn } from '@shres-code/shres-code-loader-smoke'
import { SessionId } from '@shres-code/shres-code-session'

const NAME = 'model-router-select-driver'
const [configPath, flag, promptsJson] = process.argv.slice(2)
if (configPath === undefined || flag !== '--tasks-json' || promptsJson === undefined) {
  throw new Error(`${NAME}: expected <config-path> --tasks-json <prompts>`)
}
const prompts: unknown = JSON.parse(promptsJson)
if (!Array.isArray(prompts) || prompts.length < 2 || prompts.some(prompt => typeof prompt !== 'string')) {
  throw new Error(`${NAME}: expected at least two prompts`)
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
  const { agent, dispose } = await ctx.agents.create({
    sessionId,
    meta: { cwd: process.cwd() },
    agentOptions: original,
  })
  await runFixtureTurn(ctx, { task: prompts[0] as string })
  const header = agent.session.requestHeader()
  assert.ok(header)
  const selected = { provider: header.config.provider, model: header.config.model }
  assert.notEqual(selected.model, original.model)
  await applyModelSwitch(defaults, agent, { kind: 'set', ...selected })
  let result: Awaited<ReturnType<typeof runFixtureTurn>> | undefined
  for (const task of prompts.slice(1) as string[]) {
    result = await runFixtureTurn(ctx, { task })
    assert.deepEqual(defaults.selectionFor(agent).current, selected)
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
  await ctx.sessions.flush(agent.session)
  await dispose()
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  await ctx?.fiber.dispose()
  uninstallFailLoud()
}
