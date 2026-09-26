import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@shres-code/cordis'
import SystemPrompt from '@shres-code/shres-code-system-prompt'
import ToolRuntime from '@shres-code/shres-code-tools'
import SkillRegistry from '@shres-code/shres-code-skill'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as browserSkill from '../src/index.ts'

const names = ['browser_act', 'browser_navigate', 'browser_observe', 'browser_session']

let home = ''

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'shres-bsk-index-'))
  process.env.SHRES_HOME = home
})

afterEach(async () => {
  delete process.env.SHRES_HOME
  await rm(home, { recursive: true, force: true })
})

describe('browserskill plugin mounting', () => {
  it('mounts the runtime, the browser tools, and the guidance into the context', async () => {
    const ctx = new Context()
    const services = [ctx.plugin(SystemPrompt), ctx.plugin(ToolRuntime, { mode: 'native' }), ctx.plugin(SkillRegistry)]
    for (const service of services) await service.await()
    const fiber = ctx.plugin(browserSkill)
    await fiber.await()
    expect(browserSkill.name).toBe('browserskill')
    expect(browserSkill.inject).toEqual(['tools', 'skills'])
    expect(ctx.tools.schemas().map(tool => tool.name).sort()).toEqual(names)
    expect(await ctx.skills.get('browserskill')).toBeDefined()
  })

  it('withdraws every contribution on disposal', async () => {
    const ctx = new Context()
    const services = [ctx.plugin(SystemPrompt), ctx.plugin(ToolRuntime, { mode: 'native' }), ctx.plugin(SkillRegistry)]
    for (const service of services) await service.await()
    const fiber = ctx.plugin(browserSkill)
    await fiber.await()
    await fiber.dispose()
    expect(ctx.tools.schemas()).toEqual([])
    expect(await ctx.skills.get('browserskill')).toBeUndefined()
  })

  it('hands the Loader-validated deployment values to the runtime resolver', () => {
    const config = browserSkill.Config({ commandTimeoutMs: 12_000, healthIntervalMs: 1_000 })
    expect(config.commandTimeoutMs).toBe(12_000)
    expect(config.healthIntervalMs).toBe(1_000)
    expect(config.artifactBaseUrl).toBeUndefined()
  })
})
