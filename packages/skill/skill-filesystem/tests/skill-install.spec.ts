import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { Context } from '@shres-code/cordis'
import SkillRegistry from '@shres-code/shres-code-skill'
import * as SkillFileSystem from '../src/index.ts'
import { addInstalledSkill, defaultSkillInstallRoots, listInstalledSkills, removeInstalledSkill, type SkillInstallRoots } from '../src/install.ts'

const INSTALLED_ROOT_SEGMENTS = ['.shres', 'skills-installed']

async function tempDir(name: string): Promise<string> {
  return await import('node:fs/promises').then(fs => fs.mkdtemp(join(tmpdir(), `shres-${name}-`)))
}

async function writeSkillSource(source: string, name: string, body = 'Installed body.'): Promise<void> {
  await mkdir(source, { recursive: true })
  await writeFile(join(source, 'SKILL.md'), `---\nname: ${name}\ndescription: Installed ${name}\n---\n\n${body}\n`)
}

function rootsFor(home: string, overrides: Partial<SkillInstallRoots> = {}): SkillInstallRoots {
  return {
    shresHome: join(home, '.shres'),
    agentsHome: join(home, '.agents'),
    ...overrides,
  }
}

function installedRoot(home: string): string {
  return join(home, ...INSTALLED_ROOT_SEGMENTS)
}

/** The staging parent: a sibling of the installed root, never a discovery root. */
function stagingRoot(home: string): string {
  return join(home, '.shres', '.skills-installed-staging')
}

/** Entries left in the staging parent; absent and empty both mean no residue. */
async function stagingResidue(home: string): Promise<string[]> {
  return existsSync(stagingRoot(home)) ? await readdir(stagingRoot(home)) : []
}

const savedShresHome = process.env.SHRES_HOME
const savedAgentsHome = process.env.SHRES_AGENTS_HOME

beforeEach(() => {
  delete process.env.SHRES_HOME
  delete process.env.SHRES_AGENTS_HOME
})

afterEach(() => {
  if (savedShresHome === undefined) delete process.env.SHRES_HOME
  else process.env.SHRES_HOME = savedShresHome
  if (savedAgentsHome === undefined) delete process.env.SHRES_AGENTS_HOME
  else process.env.SHRES_AGENTS_HOME = savedAgentsHome
})

describe('defaultSkillInstallRoots', () => {
  it('resolves homes from the environment and walks to the nearest .git ancestor', async () => {
    const home = await tempDir('install-default-roots')
    const project = await tempDir('install-default-project')
    await mkdir(join(project, 'nested/.git'), { recursive: true })
    process.env.SHRES_HOME = join(home, 'shres-home')
    process.env.SHRES_AGENTS_HOME = join(home, 'agents-home')

    const roots = defaultSkillInstallRoots(join(project, 'nested', 'packages', 'app'))

    expect(roots.shresHome).toBe(join(home, 'shres-home'))
    expect(roots.agentsHome).toBe(join(home, 'agents-home'))
    expect(roots.projectRoot).toBe(join(project, 'nested'))
    expect(roots.customSkillDirs).toBeUndefined()

    delete process.env.SHRES_AGENTS_HOME
    expect(defaultSkillInstallRoots(project).agentsHome).toBe(join(homedir(), '.agents'))

    const plain = await tempDir('install-default-plain')
    const noMarker = defaultSkillInstallRoots(join(plain, 'nested', 'packages', 'app'))
    expect(noMarker.projectRoot).toBe(join(plain, 'nested', 'packages', 'app'))
    await rm(home, { recursive: true, force: true })
    await rm(project, { recursive: true, force: true })
    await rm(plain, { recursive: true, force: true })
  })
})

describe('addInstalledSkill', () => {
  it('copies a source tree into the installed root with provenance and no residue', async () => {
    const home = await tempDir('install-add')
    const source = join(home, 'sources', 'my-source-dir')
    await writeSkillSource(source, 'installed-thing')
    await mkdir(join(source, 'references'), { recursive: true })
    await writeFile(join(source, 'references', 'guide.md'), 'Guide text.')
    await writeFile(join(source, 'references', 'zz-appendix.md'), 'Appendix text.')

    await mkdir(join(source, 'assets'), { recursive: true })
    await writeFile(join(source, 'assets', 'logo.txt'), 'logo')
    const outcome = await addInstalledSkill(source, rootsFor(home))

    expect(outcome).toEqual({
      kind: 'installed',
      name: 'installed-thing',
      path: join(installedRoot(home), 'installed-thing'),
      digest: expect.stringMatching(/^sha256-[0-9a-f]{64}$/) as unknown,
    })
    expect(await readFile(join(installedRoot(home), 'installed-thing', 'SKILL.md'), 'utf8')).toContain('installed-thing')
    expect(await readFile(join(installedRoot(home), 'installed-thing', 'references', 'guide.md'), 'utf8')).toBe('Guide text.')
    expect(await readFile(join(installedRoot(home), 'installed-thing', 'assets', 'logo.txt'), 'utf8')).toBe('logo')
    const provenance = JSON.parse(await readFile(join(installedRoot(home), 'installed-thing', '.shres-skill.json'), 'utf8')) as Record<string, unknown>
    expect(provenance).toEqual({
      origin: await realpath(source),
      digest: (outcome as { digest: string }).digest,
      installedAt: expect.any(String) as unknown,
    })
    expect((await readdir(installedRoot(home)))).toEqual(['installed-thing'])
    await rm(home, { recursive: true, force: true })
  })

  it('uses the frontmatter name, not the source directory name', async () => {
    const home = await tempDir('install-frontmatter-name')
    const source = join(home, 'arbitrary-dir')
    await writeSkillSource(source, 'renamed-skill')

    const outcome = await addInstalledSkill(source, rootsFor(home))

    expect(outcome).toMatchObject({ kind: 'installed', name: 'renamed-skill', path: join(installedRoot(home), 'renamed-skill') })
    await rm(home, { recursive: true, force: true })
  })

  it('is discoverable by the provider as the installed source', async () => {
    const home = await tempDir('install-discovery')
    const source = join(home, 'source')
    await writeSkillSource(source, 'live-skill')
    await addInstalledSkill(source, rootsFor(home))

    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFileSystem, {
      shresHome: join(home, '.shres'),
      agentsHome: join(home, '.agents'),
      watch: false,
    })

    expect((await ctx.skills.list()).map(skill => [skill.name, skill.source])).toEqual([['live-skill', 'installed']])
    await rm(home, { recursive: true, force: true })
  })

  it('produces the same digest for identical content and a different one after edits', async () => {
    const homeA = await tempDir('install-digest-a')
    const homeB = await tempDir('install-digest-b')
    const sourceA = join(homeA, 'source')
    const sourceB = join(homeB, 'source')
    await writeSkillSource(sourceA, 'same-skill', 'Identical body.')
    await writeSkillSource(sourceB, 'same-skill', 'Identical body.')
    const first = await addInstalledSkill(sourceA, rootsFor(homeA))
    const second = await addInstalledSkill(sourceB, rootsFor(homeB))
    expect(first.kind).toBe('installed')
    expect(second.kind).toBe('installed')
    expect((first as { digest: string }).digest).toBe((second as { digest: string }).digest)

    await writeSkillSource(sourceB, 'same-skill', 'Edited body.')
    await rm(join(installedRoot(homeB), 'same-skill'), { recursive: true, force: true })
    const third = await addInstalledSkill(sourceB, rootsFor(homeB))
    expect(third.kind).toBe('installed')
    expect((third as { digest: string }).digest).not.toBe((first as { digest: string }).digest)
    await rm(homeA, { recursive: true, force: true })
    await rm(homeB, { recursive: true, force: true })
  })

  it('refuses invalid sources before creating the installed root', async () => {
    const home = await tempDir('install-invalid')
    const missing = await addInstalledSkill(join(home, 'missing'), rootsFor(home))
    expect(missing).toMatchObject({ kind: 'refused', code: 'invalid-skill' })

    const flatFile = join(home, 'flat.md')
    await writeFile(flatFile, 'not a directory')
    expect(await addInstalledSkill(flatFile, rootsFor(home)))
      .toMatchObject({ kind: 'refused', code: 'invalid-skill', detail: expect.stringContaining('not a directory') as unknown })

    const empty = join(home, 'empty')
    await mkdir(empty, { recursive: true })
    expect(await addInstalledSkill(empty, rootsFor(home)))
      .toMatchObject({ kind: 'refused', code: 'invalid-skill', detail: expect.stringContaining('SKILL.md') as unknown })

    const badName = join(home, 'bad-name')
    await writeSkillSource(badName, 'Bad_Name')
    expect(await addInstalledSkill(badName, rootsFor(home)))
      .toMatchObject({ kind: 'refused', code: 'invalid-skill', detail: expect.stringContaining('invalid skill name') as unknown })
    expect(existsSync(installedRoot(home))).toBe(false)
    await rm(home, { recursive: true, force: true })
  })

  it('propagates a read failure when SKILL.md is not a regular file', async () => {
    const home = await tempDir('install-eisdir')
    const source = join(home, 'source')
    await mkdir(join(source, 'SKILL.md'), { recursive: true })
    await expect(addInstalledSkill(source, rootsFor(home))).rejects.toThrow()
    expect(existsSync(installedRoot(home))).toBe(false)
    await rm(home, { recursive: true, force: true })
  })

  it('refuses names owned by any filesystem root and reports the winning owner', async () => {
    const home = await tempDir('install-name-taken')
    const project = await tempDir('install-name-project')
    const custom = await tempDir('install-name-custom')
    const source = join(home, 'source')
    await writeSkillSource(source, 'dupe-skill')

    await writeSkillSource(join(project, '.shres/skills', 'dupe-skill'), 'dupe-skill')
    expect(await addInstalledSkill(source, rootsFor(home, { projectRoot: project })))
      .toMatchObject({ kind: 'refused', code: 'name-taken', owner: 'project-shres' })

    await writeSkillSource(join(project, '.agents/skills', 'dupe-skill'), 'dupe-skill')
    await rm(join(project, '.shres/skills', 'dupe-skill'), { recursive: true, force: true })
    expect(await addInstalledSkill(source, rootsFor(home, { projectRoot: project })))
      .toMatchObject({ kind: 'refused', code: 'name-taken', owner: 'project-agents' })

    await writeSkillSource(join(custom, 'dupe-skill'), 'dupe-skill')
    expect(await addInstalledSkill(source, rootsFor(home, { customSkillDirs: [custom] })))
      .toMatchObject({ kind: 'refused', code: 'name-taken', owner: 'custom' })

    await writeSkillSource(join(home, '.shres/skills', 'dupe-skill'), 'dupe-skill')
    expect(await addInstalledSkill(source, rootsFor(home)))
      .toMatchObject({ kind: 'refused', code: 'name-taken', owner: 'user-shres' })

    await rm(join(home, '.shres/skills', 'dupe-skill'), { recursive: true, force: true })
    await writeFile(join(home, '.shres/skills', 'dupe-skill.md'), '---\nname: dupe-skill\ndescription: flat\n---\n\nFlat.\n')
    expect(await addInstalledSkill(source, rootsFor(home)))
      .toMatchObject({ kind: 'refused', code: 'name-taken', owner: 'user-shres' })
    await rm(join(home, '.shres/skills', 'dupe-skill.md'), { force: true })

    expect(await addInstalledSkill(source, rootsFor(home))).toMatchObject({ kind: 'installed' })
    expect(await addInstalledSkill(source, rootsFor(home)))
      .toMatchObject({ kind: 'refused', code: 'name-taken', owner: 'installed' })
    await rm(home, { recursive: true, force: true })
    await rm(project, { recursive: true, force: true })
    await rm(custom, { recursive: true, force: true })
  })

  it('refuses symbolic links in the source tree and leaves no residue', async () => {
    const home = await tempDir('install-symlink')
    const outside = join(home, 'outside')
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'secret.txt'), 'secret')
    const source = join(home, 'source')
    await writeSkillSource(source, 'linked-skill')
    await mkdir(join(source, 'references'), { recursive: true })
    await symlink(join(outside, 'secret.txt'), join(source, 'references', 'leak.txt'))
    await symlink(outside, join(source, 'inside-dir-link'))

    const outcome = await addInstalledSkill(source, rootsFor(home))
    expect(outcome).toMatchObject({
      kind: 'refused',
      code: 'escaping-symlink',
      detail: expect.stringContaining('symbolic link') as unknown,
    })
    expect(existsSync(join(installedRoot(home), 'linked-skill'))).toBe(false)
    expect(await stagingResidue(home)).toEqual([])
    await rm(home, { recursive: true, force: true })
  })

  it.runIf(process.platform !== 'win32')('cleans staging and propagates when a source file is unreadable', async () => {
    const home = await tempDir('install-eacces')
    const source = join(home, 'source')
    await writeSkillSource(source, 'blocked-skill')
    await mkdir(join(source, 'references'), { recursive: true })
    const sealed = join(source, 'references', 'sealed.md')
    await writeFile(sealed, 'unreadable')
    await chmod(sealed, 0o000)

    try {
      await expect(addInstalledSkill(source, rootsFor(home))).rejects.toThrow()
    } finally {
      await chmod(sealed, 0o644)
    }
    expect(existsSync(join(installedRoot(home), 'blocked-skill'))).toBe(false)
    expect(await stagingResidue(home)).toEqual([])
    await rm(home, { recursive: true, force: true })
  })

  it('propagates a pre-aborted signal without installing', async () => {
    const home = await tempDir('install-abort')
    const source = join(home, 'source')
    await writeSkillSource(source, 'aborted-skill')
    const controller = new AbortController()
    controller.abort()
    await expect(addInstalledSkill(source, rootsFor(home), { signal: controller.signal })).rejects.toThrow()
    expect(existsSync(join(installedRoot(home), 'aborted-skill'))).toBe(false)
    await rm(home, { recursive: true, force: true })
  })
})

describe('removeInstalledSkill', () => {
  it('removes a managed install and reports missing names', async () => {
    const home = await tempDir('install-remove')
    const source = join(home, 'source')
    await writeSkillSource(source, 'doomed-skill')
    await addInstalledSkill(source, rootsFor(home))

    expect(await removeInstalledSkill('doomed-skill', rootsFor(home))).toEqual({ kind: 'removed' })
    expect(existsSync(join(installedRoot(home), 'doomed-skill'))).toBe(false)
    expect(await removeInstalledSkill('doomed-skill', rootsFor(home))).toEqual({ kind: 'refused', code: 'not-installed' })
    expect(await removeInstalledSkill('never-there', rootsFor(home))).toEqual({ kind: 'refused', code: 'not-installed' })
    await rm(home, { recursive: true, force: true })
  })

  it('never deletes entries it did not install', async () => {
    const home = await tempDir('install-not-managed')
    const root = installedRoot(home)
    await mkdir(root, { recursive: true, mode: 0o700 })

    const handPlaced = join(root, 'hand-placed')
    await writeSkillSource(handPlaced, 'hand-placed')
    expect(await removeInstalledSkill('hand-placed', rootsFor(home))).toEqual({ kind: 'refused', code: 'not-managed' })
    expect(existsSync(handPlaced)).toBe(true)

    const malformed = join(root, 'malformed')
    await writeSkillSource(malformed, 'malformed')
    await writeFile(join(malformed, '.shres-skill.json'), '{ not json')
    expect(await removeInstalledSkill('malformed', rootsFor(home))).toEqual({ kind: 'refused', code: 'not-managed' })
    expect(existsSync(malformed)).toBe(true)

    const incomplete = join(root, 'incomplete')
    await writeSkillSource(incomplete, 'incomplete')
    await writeFile(join(incomplete, '.shres-skill.json'), JSON.stringify({ origin: '/only-origin' }))
    expect(await removeInstalledSkill('incomplete', rootsFor(home))).toEqual({ kind: 'refused', code: 'not-managed' })

    const nullProvenance = join(root, 'null-provenance')
    await writeSkillSource(nullProvenance, 'null-provenance')
    await writeFile(join(nullProvenance, '.shres-skill.json'), 'null')
    expect(await removeInstalledSkill('null-provenance', rootsFor(home))).toEqual({ kind: 'refused', code: 'not-managed' })

    const outside = await tempDir('install-not-managed-outside')
    const linked = join(root, 'linked')
    await symlink(outside, linked)
    expect(await removeInstalledSkill('linked', rootsFor(home))).toEqual({ kind: 'refused', code: 'not-managed' })
    expect(existsSync(outside)).toBe(true)

    await writeFile(join(root, 'flat-file'), 'not a skill directory')
    expect(await removeInstalledSkill('flat-file', rootsFor(home))).toEqual({ kind: 'refused', code: 'not-managed' })
    expect(existsSync(join(root, 'flat-file'))).toBe(true)
    // A flat Markdown skill is outside the managed directory namespace.
    await writeFile(join(root, 'flat-doc.md'), '---\nname: flat-doc\ndescription: flat\n---\n')
    expect(await removeInstalledSkill('flat-doc', rootsFor(home))).toEqual({ kind: 'refused', code: 'not-installed' })
    expect(existsSync(join(root, 'flat-doc.md'))).toBe(true)

    expect(await removeInstalledSkill('Bad_Name', rootsFor(home))).toEqual({ kind: 'refused', code: 'not-installed' })
    expect(await removeInstalledSkill('anything', rootsFor(join(home, 'missing-home')))).toEqual({ kind: 'refused', code: 'not-installed' })

    const fileHome = join(home, 'file-as-home')
    await writeFile(fileHome, 'not a directory')
    expect(await removeInstalledSkill('anything', rootsFor(fileHome))).toEqual({ kind: 'refused', code: 'not-installed' })
    await rm(home, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })
})

describe('listInstalledSkills', () => {
  it('reports managed installs and skips unmanaged or broken directories', async () => {
    const home = await tempDir('install-list')
    const first = join(home, 'first')
    const second = join(home, 'second')
    const third = join(home, 'third')
    await writeSkillSource(first, 'a-first')
    await writeSkillSource(second, 'b-second')
    await writeSkillSource(third, 'c-third')
    // Insertion order a, c, b makes the catalog sort compare both ways.
    await addInstalledSkill(first, rootsFor(home))
    await addInstalledSkill(third, rootsFor(home))
    await addInstalledSkill(second, rootsFor(home))

    const root = installedRoot(home)
    await writeSkillSource(join(root, 'hand-placed'), 'hand-placed')
    const broken = join(root, 'broken')
    await writeSkillSource(broken, 'broken')
    await writeFile(join(broken, '.shres-skill.json'), JSON.stringify({ origin: broken, digest: 'sha256-x', installedAt: 'now' }))
    await rm(join(broken, 'SKILL.md'))
    const mismatched = join(root, 'mismatched-dir')
    await writeSkillSource(mismatched, 'other-name')
    await writeFile(join(mismatched, '.shres-skill.json'), JSON.stringify({ origin: mismatched, digest: 'sha256-x', installedAt: 'now' }))
    await mkdir(join(root, '.staging-residue'), { recursive: true })
    await symlink(root, join(root, 'linked'))

    const listed = await listInstalledSkills(rootsFor(home))
    expect(listed.map(skill => skill.name)).toEqual(['a-first', 'b-second', 'c-third'])
    expect(listed[0]).toMatchObject({
      name: 'a-first',
      description: 'Installed a-first',
      digest: expect.stringMatching(/^sha256-[0-9a-f]{64}$/) as unknown,
      origin: await realpath(first),
      installedAt: expect.any(String) as unknown,
    })
    await rm(home, { recursive: true, force: true })
  })

  it('returns an empty list when the installed root does not exist', async () => {
    const home = await tempDir('install-list-missing')
    expect(await listInstalledSkills(rootsFor(home))).toEqual([])
    await rm(home, { recursive: true, force: true })
  })
})

describe('install staging', () => {
  it('stages outside the installed root, so the discovered root only ever holds published skills', async () => {
    const home = await tempDir('install-staging-outside')
    const source = join(home, 'source')
    await writeSkillSource(source, 'staged-skill')
    await addInstalledSkill(source, rootsFor(home))

    // The writer lock file is removed on release, so only the skill remains.
    expect(await readdir(installedRoot(home))).toEqual(['staged-skill'])
    expect(await stagingResidue(home)).toEqual([])
    await rm(home, { recursive: true, force: true })
  })

  it('sweeps residue an interrupted install left in the staging parent', async () => {
    const home = await tempDir('install-staging-sweep')
    await writeSkillSource(join(stagingRoot(home), 'interrupted'), 'interrupted-skill')
    const source = join(home, 'source')
    await writeSkillSource(source, 'fresh-skill')

    expect(await addInstalledSkill(source, rootsFor(home))).toMatchObject({ kind: 'installed', name: 'fresh-skill' })
    expect(await stagingResidue(home)).toEqual([])
    expect(existsSync(join(installedRoot(home), 'interrupted-skill'))).toBe(false)
    await rm(home, { recursive: true, force: true })
  })
})
