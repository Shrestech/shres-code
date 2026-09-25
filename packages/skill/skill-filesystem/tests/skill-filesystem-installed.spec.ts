import { describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { Context } from '@shres-code/cordis'
import { SandboxedFileSystem } from '@shres-code/shres-code-fs-sandbox'
import SandboxPolicyService from '@shres-code/shres-code-sandbox-policy'
import SkillRegistry, { renderSkillContent } from '@shres-code/shres-code-skill'
import * as SkillFileSystem from '../src/index.ts'

async function tempDir(name: string): Promise<string> {
  return await import('node:fs/promises').then(fs => fs.mkdtemp(join(tmpdir(), `shres-${name}-`)))
}

async function writeSkill(root: string, name: string, description: string, body = 'Use the skill.'): Promise<void> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`)
}

async function writeFlatSkill(root: string, name: string, description: string, body = 'Flat body.'): Promise<void> {
  await mkdir(root, { recursive: true })
  await writeFile(join(root, `${name}.md`), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`)
}

async function setupLocal(home: string, config: Partial<SkillFileSystem.Config> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(SkillFileSystem, {
    shresHome: join(home, '.shres'),
    agentsHome: join(home, '.agents'),
    watch: false,
    ...config,
  })
  return ctx
}

describe('installed skill root', () => {
  it('discovers installed bundle and flat skills with the installed source', async () => {
    const home = await tempDir('skill-installed')
    const installed = join(home, '.shres/skills-installed')
    await writeSkill(installed, 'installed-bundle', 'Installed bundle', 'Installed body.')
    await writeFlatSkill(installed, 'installed-flat', 'Installed flat')

    const ctx = await setupLocal(home)

    expect((await ctx.skills.list()).map(skill => [skill.name, skill.source])).toEqual([
      ['installed-bundle', 'installed'],
      ['installed-flat', 'installed'],
    ])
    expect(await ctx.skills.get('installed-bundle')).toMatchObject({
      content: 'Installed body.',
      provider: 'filesystem',
      resourceBase: { kind: 'directory', path: join(installed, 'installed-bundle') },
    })
  })

  it('omits the installed root for isolated providers', async () => {
    const home = await tempDir('skill-installed-isolated')
    await writeSkill(join(home, '.shres/skills-installed'), 'installed-only', 'Installed only')

    const ctx = await setupLocal(home, { includeDefaultRoots: false })

    expect(await ctx.skills.list()).toEqual([])
  })

  it('keeps an installed skill below every trusted tier of the same name', async () => {
    const home = await tempDir('skill-installed-precedence')
    await writeSkill(join(home, '.shres/skills-installed'), 'same', 'Installed loses')

    const aloneCtx = await setupLocal(home)
    expect((await aloneCtx.skills.get('same'))?.description).toBe('Installed loses')

    const bundled = await tempDir('skill-installed-precedence-bundled')
    await writeSkill(bundled, 'same', 'Bundled wins')
    const bundledCtx = await setupLocal(home, { bundledSkillDir: bundled })
    expect((await bundledCtx.skills.get('same'))?.description).toBe('Bundled wins')

    await writeSkill(join(home, '.shres/skills'), 'same', 'User wins')
    const userCtx = await setupLocal(home)
    expect((await userCtx.skills.get('same'))?.description).toBe('User wins')
    expect((await userCtx.skills.list()).filter(skill => skill.name === 'same')).toHaveLength(1)

    const runtimeCtx = await setupLocal(home)
    runtimeCtx.skills.register({ name: 'same', description: 'Runtime wins', source: 'runtime', content: 'Runtime body.' })
    expect((await runtimeCtx.skills.get('same'))?.description).toBe('Runtime wins')

    const project = await tempDir('skill-installed-precedence-project')
    await mkdir(join(project, '.git'), { recursive: true })
    await writeSkill(join(project, '.shres/skills'), 'same', 'Project wins')
    const projectCtx = await setupLocal(home)
    expect((await projectCtx.skills.get('same', { cwd: project }))?.description).toBe('Project wins')
  })
})

describe('installed skill root through the sandboxed filesystem', () => {
  it('discovers and loads an installed skill through ctx.fs under workspace-write with an unrelated workspace', async () => {
    // Under HOME rather than tmpdir: workspace-write grants tmpdir, so only a
    // home-rooted layout proves the installed root lies outside every grant.
    const base = await mkdtemp(join(homedir(), '.shres-skill-installed-sandbox-'))
    try {
      const workspace = join(base, 'workspace')
      const home = join(base, 'home')
      await mkdir(join(workspace, '.git'), { recursive: true })
      await writeSkill(join(home, '.shres/skills-installed'), 'sandboxed-installed', 'Installed outside the workspace', 'Sandboxed body.')

      const ctx = new Context()
      await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: workspace })
      await ctx.plugin(SandboxedFileSystem, { cwd: workspace })
      const sandboxedFs = ctx.get('fs')
      if (sandboxedFs === undefined) throw new Error('the sandboxed filesystem did not register as ctx.fs')
      const resolve = vi.spyOn(sandboxedFs, 'resolve')
      await ctx.plugin(SkillRegistry)
      await ctx.plugin(SkillFileSystem, {
        shresHome: join(home, '.shres'),
        agentsHome: join(home, '.agents'),
        watch: false,
      })

      expect((await ctx.skills.list({ cwd: workspace })).map(skill => [skill.name, skill.source]))
        .toEqual([['sandboxed-installed', 'installed']])
      const loaded = await ctx.skills.get('sandboxed-installed', { cwd: workspace })
      expect(loaded?.content).toBe('Sandboxed body.')
      // The body was read through the sandboxed backend, not direct node:fs.
      expect(resolve.mock.calls.some(([path]) => path.includes('skills-installed'))).toBe(true)
      if (loaded === undefined) throw new Error('unreachable: asserted above')
      // Readable is not trusted: the loaded body still renders untrusted.
      expect(renderSkillContent(loaded)).toContain('untrusted')
      await ctx.fiber.dispose()
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})
