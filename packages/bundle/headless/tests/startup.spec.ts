/**
 * The one-shot app's ordinary command-line provider over a real Loader tree:
 * the task becomes injected runner config, while help and usage errors leave
 * the consumer pending.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@shres-code/cordis'
import Loader from '@shres-code/cordis-plugin-loader'
import Include from '@shres-code/cordis-plugin-include'
import { internals, provideCmdline } from '@shres-code/shres-code-cmdline'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, HEADLESS_STARTUP_SERVICE, type HeadlessStartupValues } from '../src/startup.ts'

/** What one boot of the fixture tree observed. */
interface Observed {
  exits: number[]
  out: string
  runnerConfig?: unknown
}

const disposers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  internals.stdout = process.stdout
  internals.stderr = process.stderr
})

/**
 * Mount the real provider over a runner stand-in.
 * @param args - the invocation's inner arguments.
 * @returns the resolved service value and observed runner/process effects.
 */
async function bootStartup(args: string[]): Promise<{ task: HeadlessStartupValues | undefined; observed: Observed }> {
  const dir = mkdtempSync(join(tmpdir(), 'shres-headless-startup-'))
  const observed: Observed = { exits: [], out: '' }
  writeFileSync(join(dir, 'row.mjs'), 'export function apply(_ctx, config) { globalThis.__headlessStartupObserved.runnerConfig = config }\n')
  // Loader imports through Node's resolver, so this fixture delegates to the
  // source-plane plugin already imported by the test.
  writeFileSync(join(dir, 'startup.mjs'), `
export const name = 'headless-startup'
export const inject = ['cmdlineArgs']
export const apply = ctx => globalThis.__headlessStartupApply(ctx)
`)
  const rowUrl = pathToFileURL(join(dir, 'row.mjs')).href
  writeFileSync(join(dir, 'cordis.yml'), [
    '- id: headless-runner',
    `  name: ${rowUrl}`,
    `  inject: [${HEADLESS_STARTUP_SERVICE}]`,
    '  config:',
    '    task: !!js ctx.headlessStartup.task',
    '    sessionId: !!js ctx.headlessStartup.sessionId',
    '    resume: !!js ctx.headlessStartup.resume',
    '- id: headless-startup',
    `  name: ${pathToFileURL(join(dir, 'startup.mjs')).href}`,
    '',
  ].join('\n'))
  const observing = { write: (chunk: string) => { observed.out += chunk; return true } }
  internals.stdout = observing
  internals.stderr = observing
  const globals = globalThis as unknown as {
    __headlessStartupApply: typeof apply
    __headlessStartupObserved: Observed
  }
  globals.__headlessStartupApply = apply
  globals.__headlessStartupObserved = observed

  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  provideCmdline(ctx, { args, exit: code => void observed.exits.push(code) })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
  await ctx.loader.await()
  disposers.push(async () => { await ctx.fiber.dispose() })
  return {
    task: ctx.get(HEADLESS_STARTUP_SERVICE) as HeadlessStartupValues | undefined,
    observed,
  }
}

describe('headless command-line provider', () => {
  it('joins the task positional into the runner config', async () => {
    const { task, observed } = await bootStartup(['run', 'the', 'tests'])
    expect(task).toEqual({ task: 'run the tests' })
    expect(observed.runnerConfig).toEqual({ task: 'run the tests' })
    expect(observed.exits).toEqual([])
  })

  it.each([{ args: [] }, { args: ['   '] }])('rejects an invocation with no non-whitespace task ($args)', async ({ args }) => {
    const { task, observed } = await bootStartup(args)
    expect(observed.out).toContain('a task is required')
    expect(task).toBeUndefined()
    expect(observed.runnerConfig).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('publishes an explicit fresh-session id next to the task', async () => {
    const { task, observed } = await bootStartup(['--session-id', 'bench-id', 'run', 'the', 'tests'])
    expect(task).toEqual({ task: 'run the tests', sessionId: 'bench-id' })
    expect(observed.runnerConfig).toMatchObject({ task: 'run the tests', sessionId: 'bench-id' })
    expect(observed.exits).toEqual([])
  })

  it('publishes a resume id next to the task', async () => {
    const { task, observed } = await bootStartup(['--resume', 'bench-id', 'keep', 'going'])
    expect(task).toEqual({ task: 'keep going', resume: 'bench-id' })
    expect(observed.runnerConfig).toMatchObject({ task: 'keep going', resume: 'bench-id' })
    expect(observed.exits).toEqual([])
  })

  it('rejects an invocation that names both session flags', async () => {
    const { task, observed } = await bootStartup(['--session-id', 'a', '--resume', 'b', 'run'])
    expect(observed.out).toContain('--session-id and --resume are mutually exclusive')
    expect(task).toBeUndefined()
    expect(observed.runnerConfig).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it.each([{ args: ['--session-id', 'a'] }, { args: ['--resume', 'b'] }])('still requires the task positional alongside $args', async ({ args }) => {
    const { task, observed } = await bootStartup(args)
    expect(observed.out).toContain('a task is required')
    expect(task).toBeUndefined()
    expect(observed.runnerConfig).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('prints its own help and leaves the runner pending', async () => {
    const { task, observed } = await bootStartup(['--help'])
    expect(observed.out).toContain('shres --profile headless')
    expect(observed.out).toContain('--session-id')
    expect(observed.out).toContain('--resume')
    expect(task).toBeUndefined()
    expect(observed.runnerConfig).toBeUndefined()
    expect(observed.exits).toEqual([0])
  })
})
