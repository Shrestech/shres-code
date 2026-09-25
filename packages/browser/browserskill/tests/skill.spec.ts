/** Browser guidance remains owned by its plugin across disposal and remount. */
import { Context } from '@shres-code/cordis'
import SkillRegistry from '@shres-code/shres-code-skill'
import { describe, expect, it } from 'vitest'
import { registerBrowserSkillGuide } from '../src/skill.ts'

const plugin = { inject: ['skills'], apply: registerBrowserSkillGuide }

describe('BrowserSkill guidance', () => {
  it('advertises native browser tools without directing models to the raw CLI', async () => {
    const ctx = new Context()
    const service = ctx.plugin(SkillRegistry)
    const fiber = ctx.plugin(plugin)
    try {
      await service.await()
      await fiber.await()
      const skill = await ctx.skills.get('browserskill')
      expect(skill).toMatchObject({
        name: 'browserskill',
        source: 'runtime',
        invocation: { modelInvocable: true, userInvocable: true },
      })
      for (const tool of ['browser_session', 'browser_navigate', 'browser_observe', 'browser_act']) {
        expect(skill?.content).toContain(tool)
      }
      expect(skill?.content).toContain('Settings → BrowserSkill')
      expect(skill?.content).toContain('Each conversation, including each subagent, owns its own sessions.')
      expect(skill?.content).toContain('An interrupted command may already have changed the page')
      expect(skill?.content).not.toContain('bsk session start')
    } finally {
      await fiber.dispose()
      await service.dispose()
    }
  })

  it('withdraws the skill on disposal and restores it on remount', async () => {
    const ctx = new Context()
    const service = ctx.plugin(SkillRegistry)
    let fiber = ctx.plugin(plugin)
    try {
      await service.await()
      await fiber.await()
      expect(await ctx.skills.get('browserskill')).toBeDefined()
      await fiber.dispose()
      expect(await ctx.skills.get('browserskill')).toBeUndefined()
      fiber = ctx.plugin(plugin)
      await fiber.await()
      expect((await ctx.skills.list()).filter(skill => skill.name === 'browserskill')).toHaveLength(1)
    } finally {
      await fiber.dispose()
      await service.dispose()
    }
  })
})
