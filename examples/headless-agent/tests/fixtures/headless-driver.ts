#!/usr/bin/env node
/** Snapshot-only Loader driver: stream fixture turns and the final turn result as canonical JSONL. */

import type { Context } from '@shres-code/cordis'
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@shres-code/shres-code-app-boot'
import { runFixtureTurn } from '@shres-code/shres-code-loader-smoke'
import type { SessionEvent } from '@shres-code/shres-code-session'

const NAME = 'headless-test-driver'
const [configPath, ...taskParts] = process.argv.slice(2)
if (configPath === undefined || taskParts.length === 0 || taskParts.every(part => part.trim() === '')) {
  throw new Error(`${NAME}: expected <config-path> <task...>`)
}
let tasks = [taskParts.join(' ')]
if (taskParts[0] === '--tasks-json') {
  const parsed: unknown = JSON.parse(taskParts[1] ?? 'null')
  if (taskParts.length !== 2 || !Array.isArray(parsed)
    || parsed.length === 0 || parsed.some(task => typeof task !== 'string' || task.trim() === '')) {
    throw new Error(`${NAME}: --tasks-json requires a non-empty array of task strings`)
  }
  tasks = parsed as string[]
}
const [firstTask, ...followingTasks] = tasks
if (firstTask === undefined) throw new Error(`${NAME}: no task supplied`)

const uninstallFailLoud = installFailLoud(NAME)
let ctx: Context | undefined
try {
  loadEnv(NAME)
  ctx = await boot(NAME, resolveConfigPath(configPath, undefined))
  const onEvent = (sessionId: string, event: SessionEvent): void => {
    process.stdout.write(`${JSON.stringify({ type: 'session_event', sessionId, event })}\n`)
  }
  let result = await runFixtureTurn(ctx, { task: firstTask, onEvent })
  for (const task of followingTasks) result = await runFixtureTurn(ctx, { task, onEvent })
  process.stdout.write(`${JSON.stringify(result)}\n`)
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  await ctx?.fiber.dispose()
  uninstallFailLoud()
}
