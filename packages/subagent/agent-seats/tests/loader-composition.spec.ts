/**
 * Real-composition guard: a test-only cordis.yml boots seats through the
 * Loader. A hand-mounted `ctx.plugin` cannot catch a broken export shape.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@roos-code/cordis'
import Loader from '@roos-code/cordis-plugin-loader'
import Include from '@roos-code/cordis-plugin-include'
import SystemPrompt from '@roos-code/roos-code-system-prompt'
import ToolRuntime from '@roos-code/roos-code-tools'
import SubagentRuntime from '@roos-code/roos-code-subagent'
import FileSettingsProvider from '@roos-code/roos-code-settings-file'
import * as seats from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const spawnStub = {
  name: 'spawn-stub',
  inject: ['subagents'],
  apply(ctx: Context): void {
    ctx.subagents.registerProvider({
      name: 'spawn',
      capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
      inheritsParentContext: false,
      start: async () => {
        throw new Error('loader composition does not start children')
      },
      prepareContinuable: async () => ({}),
    })
  },
}

async function loadComposition(): Promise<{ ctx: Context; settingsPath: string }> {
  root = await mkdtemp(join(tmpdir(), 'roos-agent-seats-composition-'))
  const settingsPath = join(root, 'settings.yaml')
  await writeFile(settingsPath, '# personal settings\n')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: tools',
    "  name: '@roos-code/roos-code-tools'",
    '- id: system-prompt',
    "  name: '@roos-code/roos-code-system-prompt'",
    '- id: subagents',
    "  name: '@roos-code/roos-code-subagent'",
    '- id: spawn-stub',
    "  name: 'test-spawn-stub'",
    '- id: settings',
    "  name: '@roos-code/roos-code-settings-file'",
    '  config:',
    `    path: ${JSON.stringify(settingsPath)}`,
    '    debounceMs: 10',
    '- id: agent-seats',
    "  name: '@roos-code/roos-code-agent-seats'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@roos-code/roos-code-tools', ToolRuntime],
    ['@roos-code/roos-code-system-prompt', SystemPrompt],
    ['@roos-code/roos-code-subagent', SubagentRuntime],
    ['test-spawn-stub', spawnStub],
    ['@roos-code/roos-code-settings-file', FileSettingsProvider],
    ['@roos-code/roos-code-agent-seats', seats],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  return { ctx, settingsPath }
}

describe('agent-seats real composition', () => {
  it('boots unbound and remounts Boomer when settings bind the seat', async () => {
    const { ctx, settingsPath } = await loadComposition()
    expect(ctx.tools.schemas().some(schema => schema.name === 'boomer')).toBe(false)

    await writeFile(settingsPath, [
      'agent-seats:',
      '  seats:',
      '    boomer:',
      '      provider: ollama-cloud',
      '      model: kimi-k3',
      '',
    ].join('\n'))
    await vi.waitFor(() => {
      expect(ctx.tools.schemas().some(schema => schema.name === 'boomer')).toBe(true)
    }, { timeout: 5000 })
  })
})
