import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import { createScope, scopeOf } from '@shres-code/shres-code-scope'
import type { Scope, ScopeKey } from '@shres-code/shres-code-scope'
import SystemPrompt, { renderPrompt } from '@shres-code/shres-code-system-prompt'
import type { PromptSection } from '@shres-code/shres-code-system-prompt'

/** Mount the registry with a variable-bearing, multibyte persona so byte comparisons cover interpolation. */
async function mount(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { persona: 'You work on {{subject}} — naïve ✓.' })
  ctx.systemPrompt.variable('subject', () => 'the workspace')
  return ctx
}

async function mintScope(ctx: Context, name: string): Promise<Scope> {
  let scope!: Scope
  // The minter injects what scope holders reach through its dependency chain.
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, { name }) },
    { inject: ['systemPrompt'] }))
  return scope
}

function scopeKeyOf(scope: Scope): ScopeKey {
  // scopeOf never answers undefined for a context the scope itself minted.
  return scopeOf(scope.ctx)!
}

describe('prompt-prefix stability', () => {
  it('keeps the rendered bytes before the first conditional section identical under every toggle combination', async () => {
    const ctx = await mount()
    ctx.systemPrompt.section({ name: 'static:early', order: -50, text: () => 'Early static text.' })
    ctx.systemPrompt.section({ name: 'static:guidance', order: 150, stability: 'static', text: 'Static guidance.' })
    const shown = new Map<string, boolean>()
    ctx.systemPrompt.section({
      name: 'conditional:a',
      order: 500,
      stability: 'conditional',
      text: () => (shown.get('conditional:a') === true ? 'Conditional A.' : ''),
    })
    ctx.systemPrompt.section({
      name: 'conditional:b',
      order: 600,
      stability: 'conditional',
      text: () => (shown.get('conditional:b') === true ? 'Conditional B — ü.' : ''),
    })
    const conditionalNames = new Set(['conditional:a', 'conditional:b', 'conditional:c'])
    // The third conditional section toggles by registration and disposal instead of by text.
    let disposeC: (() => void) | undefined

    const prefixes: Buffer[] = []
    const rendered = new Set<string>()
    for (let mask = 0; mask < 8; mask++) {
      shown.set('conditional:a', (mask & 1) !== 0)
      shown.set('conditional:b', (mask & 2) !== 0)
      if ((mask & 4) !== 0) {
        disposeC ??= ctx.systemPrompt.section({ name: 'conditional:c', order: 700, stability: 'conditional', text: 'Conditional C.' })
      } else if (disposeC !== undefined) {
        disposeC()
        disposeC = undefined
      }

      const assembly = await ctx.systemPrompt.assemble()
      const firstConditional = assembly.sections.findIndex(section => conditionalNames.has(section.name))
      const prefix = renderPrompt({ ...assembly, sections: assembly.sections.slice(0, firstConditional) })
      const text = renderPrompt(assembly)
      expect(text.startsWith(prefix)).toBe(true)
      expect(['', '\n\n']).toContain(text.slice(prefix.length, prefix.length + 2))
      prefixes.push(Buffer.from(prefix, 'utf8'))
      rendered.add(text)
    }
    for (const prefix of prefixes) expect(prefix.equals(prefixes[0]!)).toBe(true)
    // Every combination rendered differently, so the identical prefix is not vacuous.
    expect(rendered.size).toBe(8)
  })

  it('rejects a conditional section ordered before a section whose stability is omitted, naming both', async () => {
    const ctx = await mount()
    ctx.systemPrompt.section({ name: 'conditional:early', order: 50, stability: 'conditional', text: 'toggles' })
    ctx.systemPrompt.section({ name: 'static:late', order: 150, text: 'stays' })
    await expect(ctx.systemPrompt.assemble()).rejects.toThrow(
      'conditional prompt section "conditional:early" (order 50) must be ordered after static prompt section "static:late" (order 150)',
    )
  })

  it('rejects a conditional section that shares an order with a static section, in either registration order', async () => {
    const conditional: PromptSection = { name: 'conditional:tie', order: 300, stability: 'conditional', text: 'toggles' }
    const fixed: PromptSection = { name: 'static:tie', order: 300, stability: 'static', text: 'stays' }
    for (const sections of [[conditional, fixed], [fixed, conditional]]) {
      const ctx = await mount()
      for (const section of sections) ctx.systemPrompt.section(section)
      await expect(ctx.systemPrompt.assemble()).rejects.toThrow(
        'conditional prompt section "conditional:tie" (order 300) must be ordered after static prompt section "static:tie" (order 300)',
      )
    }
  })

  it('stops rejecting once the contributing fiber of the misordered section is disposed (HMR safety)', async () => {
    const ctx = await mount()
    ctx.systemPrompt.section({ name: 'static:guidance', order: 150, text: 'stays' })
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.systemPrompt.section({ name: 'conditional:early', order: 50, stability: 'conditional', text: 'toggles' })
    }, { inject: ['systemPrompt'] }))
    await expect(ctx.systemPrompt.assemble()).rejects.toThrow('conditional prompt section "conditional:early"')

    await fiber.dispose()
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.map(section => section.name)).not.toContain('conditional:early')
  })

  it('checks the effective sections of each assembly: a scoped misordering fails only that scope', async () => {
    const ctx = await mount()
    ctx.systemPrompt.section({ name: 'static:guidance', order: 150, text: 'stays' })
    const scope = await mintScope(ctx, 'child')
    scope.ctx.systemPrompt.section({ name: 'conditional:scoped', order: 50, stability: 'conditional', text: 'toggles' })

    await expect(ctx.systemPrompt.assemble({ scope: scopeKeyOf(scope) })).rejects.toThrow('conditional prompt section "conditional:scoped"')
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain('stays')
  })

  it('lets a scoped static section shadow a misordered global conditional section', async () => {
    const ctx = await mount()
    ctx.systemPrompt.section({ name: 'shared', order: 50, stability: 'conditional', text: 'toggles' })
    ctx.systemPrompt.section({ name: 'static:guidance', order: 150, text: 'stays' })
    const scope = await mintScope(ctx, 'child')
    scope.ctx.systemPrompt.section({ name: 'shared', order: 50, text: 'fixed for this scope' })

    await expect(ctx.systemPrompt.assemble()).rejects.toThrow('conditional prompt section "shared"')
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: scopeKeyOf(scope) }))).toContain('fixed for this scope')
  })

  it('does not apply the rule while a complete section replaces the rendered prompt', async () => {
    const ctx = await mount()
    ctx.systemPrompt.section({ name: 'conditional:early', order: 50, stability: 'conditional', text: 'toggles' })
    ctx.systemPrompt.section({ name: 'static:late', order: 150, text: 'stays' })
    ctx.systemPrompt.section({ name: 'owner:complete', order: 10, complete: true, text: 'The whole prompt.' })

    expect(renderPrompt(await ctx.systemPrompt.assemble())).toBe('The whole prompt.')
  })
})
