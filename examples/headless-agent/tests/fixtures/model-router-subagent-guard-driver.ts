#!/usr/bin/env node
import type { Context } from '@shres-code/cordis'
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@shres-code/shres-code-app-boot'
import { createUserMessage } from '@shres-code/shres-code-llm'
import { SessionId } from '@shres-code/shres-code-session'

const NAME = 'model-router-subagent-guard-driver'
const [configPath, flag, promptsJson] = process.argv.slice(2)
if (configPath === undefined || flag !== '--tasks-json' || promptsJson === undefined) {
  throw new Error(`${NAME}: expected <config-path> --tasks-json <prompts>`)
}
const prompts: unknown = JSON.parse(promptsJson)
if (!Array.isArray(prompts) || prompts.length < 1 || prompts.some(prompt => typeof prompt !== 'string')) {
  throw new Error(`${NAME}: expected at least one prompt`)
}
const uninstallFailLoud = installFailLoud(NAME)
let ctx: Context | undefined
try {
  loadEnv(NAME)
  ctx = await boot(NAME, resolveConfigPath(configPath, undefined))
  const sessionId = SessionId('main')
  ctx.on('session/event', (session, event) => {
    if (session.id !== sessionId) return
    process.stdout.write(`${JSON.stringify({ type: 'session_event', sessionId, event })}\n`)
  })
  const defaults = ctx.agentDefaultModel.currentSelection()
  const { agent, dispose } = await ctx.agents.create({
    sessionId,
    meta: { cwd: process.cwd() },
    agentOptions: defaults,
  })
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: prompts[0] as string }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
  const signal = new AbortController().signal
  for (const [index, prompt] of ['CHILD_FAIL_ONE', 'CHILD_FAIL_TWO', 'CHILD_KEPT_OK'].entries()) {
    const spawnedOptions = await ctx.subagents.resolveChildRoute('spawn', {
      parent: agent,
      kind: 'subagent',
      prompt: `Reply with exactly: ${prompt}`,
      signal,
    })
    const spawned = await ctx.subagents.start('spawn', {
      prompt: [{ type: 'text', text: `Reply with exactly: ${prompt}` }],
      parent: agent,
      signal,
      ...spawnedOptions === undefined ? {} : { agentOptions: spawnedOptions },
    })
    try {
      await spawned.result
    } catch {
      // The first two children fail on the candidate with unretryable QUOTA. The third is kept.
    }
    await spawned.dispose()
    if (index === 2) {
      process.stdout.write(`${JSON.stringify({ type: 'result', output: prompt })}\n`)
    }
  }
  await ctx.sessions.flush(agent.session)
  await dispose()
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  await ctx?.fiber.dispose()
  uninstallFailLoud()
}
