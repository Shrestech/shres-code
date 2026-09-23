/**
 * Real-composition guard: a test-only cordis.yml boots seats through the
 * Loader. A hand-mounted `ctx.plugin` cannot catch a broken export shape.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@shres-code/cordis'
import Loader from '@shres-code/cordis-plugin-loader'
import Include from '@shres-code/cordis-plugin-include'
import SystemPrompt from '@shres-code/shres-code-system-prompt'
import ToolRuntime from '@shres-code/shres-code-tools'
import SubagentRuntime from '@shres-code/shres-code-subagent'
import FileSettingsProvider from '@shres-code/shres-code-settings-file'
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

async function loadComposition(settingsDocument = '# personal settings\n'): Promise<{ ctx: Context; settingsPath: string }> {
  root = await mkdtemp(join(tmpdir(), 'shres-agent-seats-composition-'))
  const settingsPath = join(root, 'settings.yaml')
  await writeFile(settingsPath, settingsDocument)
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: tools',
    "  name: '@shres-code/shres-code-tools'",
    '- id: system-prompt',
    "  name: '@shres-code/shres-code-system-prompt'",
    '- id: subagents',
    "  name: '@shres-code/shres-code-subagent'",
    '- id: spawn-stub',
    "  name: 'test-spawn-stub'",
    '- id: settings',
    "  name: '@shres-code/shres-code-settings-file'",
    '  config:',
    `    path: ${JSON.stringify(settingsPath)}`,
    '    debounceMs: 10',
    '- id: agent-seats',
    "  name: '@shres-code/shres-code-agent-seats'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@shres-code/shres-code-tools', ToolRuntime],
    ['@shres-code/shres-code-system-prompt', SystemPrompt],
    ['@shres-code/shres-code-subagent', SubagentRuntime],
    ['test-spawn-stub', spawnStub],
    ['@shres-code/shres-code-settings-file', FileSettingsProvider],
    ['@shres-code/shres-code-agent-seats', seats],
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
  it.each([
    ['an extras map', ['    cartographer:', '      provider: p', '      model: m']],
    ['an incomplete member', ['    - name: cartographer', '      role: Researcher']],
  ])('rejects %s during Loader boot', async (_name, extras) => {
    await expect(loadComposition([
      'agent-seats:',
      '  extras:',
      ...extras,
      '',
    ].join('\n'))).rejects.toThrow(
      'agent-seats: invalid settings; correct the agent-seats section in the settings document.',
    )
  })

  it('registers the namespace and remounts seats from a corrected extras list', async () => {
    const { ctx } = await loadComposition([
      'agent-seats:',
      '  seats:',
      '    aegis:',
      '      provider: ollama-cloud',
      '      model: kimi-k3',
      '  extras:',
      '    - name: cartographer',
      '      persona: Maps the repository.',
      '      provider: ollama-cloud',
      '      model: kimi-k3',
      '      role: Researcher',
      '',
    ].join('\n'))
    const descriptor = ctx.settings.describe({ redactSecrets: true }).find(entry => entry.ns === 'agent-seats')
    expect(descriptor).toBeDefined()
    expect(descriptor?.value).toMatchObject({
      seats: { aegis: { provider: 'ollama-cloud', model: 'kimi-k3' } },
      extras: [{ name: 'cartographer', role: 'Researcher' }],
    })
    expect(ctx.tools.schemas().some(schema => schema.name === 'aegis')).toBe(true)
  })

  it('boots unbound and remounts Aegis when settings bind the seat', async () => {
    const { ctx, settingsPath } = await loadComposition()
    expect(ctx.tools.schemas().some(schema => schema.name === 'aegis')).toBe(false)

    await writeFile(settingsPath, [
      'agent-seats:',
      '  seats:',
      '    aegis:',
      '      provider: ollama-cloud',
      '      model: kimi-k3',
      '',
    ].join('\n'))
    await vi.waitFor(() => {
      expect(ctx.tools.schemas().some(schema => schema.name === 'aegis')).toBe(true)
    }, { timeout: 5000 })
  })
})
