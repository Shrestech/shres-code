/**
 * Real-composition guard: a `cordis.yml` row must keep `inject` and `Config`
 * after Loader unwrapExports. `export default apply` would drop both and
 * leave schema defaults unset (docs/postmortem/0001).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@roos-code/cordis'
import Loader from '@roos-code/cordis-plugin-loader'
import Include from '@roos-code/cordis-plugin-include'
import LlmRuntime from '@roos-code/roos-code-llm'
import AgentDefaultModelConfig from '@roos-code/roos-code-agent-default-model'
import * as FirstRunSetup from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('first-run-setup Loader composition', () => {
  it('mounts ctx.firstRunSetup with schema defaults from a YAML row', async () => {
    root = await mkdtemp(join(tmpdir(), 'roos-first-run-composition-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- id: llm',
      "  name: 'test-llm-service'",
      '- id: agent-default-model',
      "  name: '@roos-code/roos-code-agent-default-model'",
      '  config:',
      '    provider: deepseek-official',
      '    model: deepseek-v4-flash',
      '- id: first-run-setup',
      "  name: '@roos-code/roos-code-first-run-setup'",
      '',
    ].join('\n'))

    const ctx = new Context()
    context = ctx
    ctx.baseUrl = `${pathToFileURL(root).href}/`
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['test-llm-service', LlmRuntime],
      ['@roos-code/roos-code-agent-default-model', AgentDefaultModelConfig],
      ['@roos-code/roos-code-first-run-setup', FirstRunSetup],
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

    expect(ctx.get('firstRunSetup')).toBeDefined()
    expect(ctx.firstRunSetup.resolvedConfig()).toEqual({
      ollamaBaseURL: FirstRunSetup.DEFAULT_OLLAMA_BASE_URL,
      detectTimeoutMs: FirstRunSetup.DEFAULT_DETECT_TIMEOUT_MS,
      autoRunCli: false,
    })
  })
})
