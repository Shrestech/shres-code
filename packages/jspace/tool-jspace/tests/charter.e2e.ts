/**
 * Nested bash charter checks: discrimination, checkpoint/ship re-run, amend.
 * Real tool-bash + fs-local. Mock only the model (there is none).
 */
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import type { Agent } from '@shres-code/shres-code-agent'
import { LocalBashExecutor } from '@shres-code/shres-code-bash-local'
import LocalFileSystem from '@shres-code/shres-code-fs-local'
import { CallId } from '@shres-code/shres-code-llm'
import SessionStore, { SessionId } from '@shres-code/shres-code-session'
import * as BashEnvPlugin from '@shres-code/shres-code-shell-env'
import LocalSubprocessRuntime from '@shres-code/shres-code-subprocess-local'
import SystemPrompt from '@shres-code/shres-code-system-prompt'
import * as ToolBash from '@shres-code/shres-code-tool-bash'
import ToolRuntime from '@shres-code/shres-code-tools'
import type { ToolExecutionResult } from '@shres-code/shres-code-tools'
import JspaceService, { CharterEntryId } from '@shres-code/shres-code-jspace'
import * as tool from '../src/index.ts'
import { CHARTER_ALREADY_REGISTERED, OPEN_REQUIRES_CHARTER, OPEN_REQUIRES_EXECUTABLE_CHARTER } from '../src/charter-resolve.ts'
import { CHARTER_FS_REQUIRED, charterProbeSymlinkRefuse } from '../src/charter-probe.ts'

const testToolSignal = new AbortController().signal

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly tmpDir: string
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  const pending = cleanups.splice(0)
  for (const cleanup of pending) await cleanup()
})

async function bashHarness(
  toolConfig: tool.Config = {
    requireCharter: true,
    requireExecutableCharter: true,
    charterDiscrimination: 'required',
  },
  jspace: ConstructorParameters<typeof JspaceService>[1] = { enabled: true },
): Promise<Harness> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'shres-charter-'))
  const spillDir = await mkdtemp(join(tmpdir(), 'shres-charter-spill-'))
  await mkdir(join(tmpDir, 'src'), { recursive: true })
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  ;(ctx.subprocess as LocalSubprocessRuntime).internals = { spillDir }
  await ctx.plugin(BashEnvPlugin)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000, graceMs: 200 })
  await ctx.plugin(ToolBash)
  await ctx.plugin(LocalFileSystem, { cwd: tmpDir })
  await ctx.plugin(JspaceService, jspace)
  await ctx.plugin(tool, toolConfig)
  const session = ctx.sessions.create(SessionId(`ws-charter-${Math.random()}`), { meta: { cwd: tmpDir } })
  const agent = { id: session.id, session } as unknown as Agent
  cleanups.push(async () => {
    await ctx.fiber.dispose()
    await rm(tmpDir, { recursive: true, force: true })
    await rm(spillDir, { recursive: true, force: true })
  })
  return { ctx, agent, tmpDir }
}

function execute(
  ctx: Context,
  name: string,
  args: unknown,
  agent: Agent,
): Promise<ToolExecutionResult> {
  const callId = CallId(`call-${name}-${Math.random()}`)
  agent.session.append('tool/call', {
    turn: 1,
    step: 1,
    callId,
    name,
    arguments: JSON.stringify(args),
  })
  return ctx.tools.execute({
    signal: testToolSignal,
    callId,
    name,
    arguments: args,
    agent,
  })
}

function text(result: ToolExecutionResult): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

const AUDIT_CHECK = {
  kind: 'check' as const,
  constraint: 'first line is the audit tag',
  command: 'grep AUDIT-TAG src/m01-sku.js',
  reads: ['src/m01-sku.js'],
  failProbe: {
    path: 'src/m01-sku.js',
    mutation: { kind: 'insert' as const, content: '// no tag\n' },
  },
}

describe('charter discrimination and nested bash', () => {
  it('credits a check when insert makes grep fail, then restores a created probe file', async () => {
    const { ctx, agent, tmpDir } = await bashHarness()
    const probe = join(tmpDir, 'src/m01-sku.js')
    const opened = await execute(ctx, 'jspace_open', {
      goal: 'Ship charter',
      next: 'Write modules',
      charter: [AUDIT_CHECK],
    }, agent)
    expect(opened.isError).toBe(false)
    expect(existsSync(probe)).toBe(false)
    const card = ctx.jspace.card(agent.session)
    expect(card?.charter).toHaveLength(1)
    expect(card?.charter[0]).toMatchObject({ kind: 'check', discrimination: 'demonstrated' })
    expect(agent.session.events.some(event => event.type === 'jspace/charter-probe'
      && event.data.demonstrated)).toBe(true)
    expect(agent.session.events.some(event => event.type === 'jspace/charter-run'
      && event.data.phase === 'probe')).toBe(true)
  }, 30_000)

  it('refuses registration when insert still passes', async () => {
    const { ctx, agent } = await bashHarness()
    const result = await execute(ctx, 'jspace_open', {
      goal: 'Ship charter',
      next: 'Write modules',
      charter: [{
        kind: 'check',
        constraint: 'file exists',
        command: 'cat src/m01-sku.js',
        reads: ['src/m01-sku.js'],
        failProbe: {
          path: 'src/m01-sku.js',
          mutation: { kind: 'insert', content: 'still readable\n' },
        },
      }],
    }, agent)
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/still passed after the failProbe/)
    expect(ctx.jspace.card(agent.session)).toBeNull()
    expect(agent.session.events.some(event => event.type === 'jspace/charter-probe'
      && event.data.demonstrated === false)).toBe(true)
  }, 30_000)

  it('refuses a missing failProbe when discrimination is required', async () => {
    const { ctx, agent } = await bashHarness()
    const result = await execute(ctx, 'jspace_open', {
      goal: 'Ship charter',
      next: 'Write modules',
      charter: [{
        kind: 'check',
        constraint: 'audit tag',
        command: 'grep AUDIT-TAG src/m01-sku.js',
        reads: ['src/m01-sku.js'],
      }],
    }, agent)
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/has no failProbe/)
  }, 30_000)

  it('refuses node --test that stays green after a qty probe', async () => {
    const { ctx, agent, tmpDir } = await bashHarness()
    await writeFile(join(tmpDir, 'ok.test.js'), [
      "import { test } from 'node:test'",
      "import assert from 'node:assert/strict'",
      "test('ok', () => { assert.equal(1, 1) })",
      '',
    ].join('\n'))
    const result = await execute(ctx, 'jspace_open', {
      goal: 'Ship charter',
      next: 'Write modules',
      charter: [{
        kind: 'check',
        constraint: 'quantities use qty()',
        command: 'node --test',
        reads: ['src/m*.js'],
        failProbe: {
          path: 'src/m-probe.js',
          mutation: { kind: 'prepend', content: 'const n = 3\n' },
        },
      }],
    }, agent)
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/still passed after the failProbe/)
  }, 30_000)

  it('dispatches nested bash with the parent token', async () => {
    const { ctx, agent } = await bashHarness()
    const parents: boolean[] = []
    ctx.on('tools/pre-execute', (exec, next) => {
      if (exec.name === 'bash') parents.push(exec.parent !== undefined)
      return next()
    })
    const opened = await execute(ctx, 'jspace_open', {
      goal: 'Ship charter',
      next: 'Write modules',
      charter: [AUDIT_CHECK],
    }, agent)
    expect(opened.isError).toBe(false)
    expect(parents).toContain(true)
  }, 30_000)

  it('surfaces a pre-execute deny as a named probe refusal', async () => {
    const { ctx, agent } = await bashHarness()
    ctx.on('tools/pre-execute', (exec, next) => {
      if (exec.name === 'bash') {
        return Promise.resolve({ kind: 'deny' as const, reason: 'blocked by test' })
      }
      return next()
    })
    const result = await execute(ctx, 'jspace_open', {
      goal: 'Ship charter',
      next: 'Write modules',
      charter: [AUDIT_CHECK],
    }, agent)
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/denied:[\s\S]*blocked by test/)
  }, 30_000)

  it('opens from kind=accept-proposal against the latest proposal', async () => {
    const { ctx, agent } = await bashHarness()
    agent.session.append('jspace/charter-proposal', {
      entries: [{ ...AUDIT_CHECK, id: CharterEntryId('e1') }],
      sourceSeq: 0,
      truncated: false,
    }, { ignorable: true })
    const opened = await execute(ctx, 'jspace_open', {
      goal: 'Ship charter',
      next: 'Write modules',
      charter: [{ kind: 'accept-proposal' }],
    }, agent)
    expect(opened.isError).toBe(false)
    expect(ctx.jspace.card(agent.session)?.charter[0]?.id).toBe('e1')
  }, 30_000)

  it('refuses an empty charter on first open when requireCharter is set', async () => {
    const { ctx, agent } = await bashHarness()
    const result = await execute(ctx, 'jspace_open', { goal: 'Ship charter', next: 'Write' }, agent)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(OPEN_REQUIRES_CHARTER)
  })

  it('refuses a prose-only charter when requireExecutableCharter is set', async () => {
    const { ctx, agent } = await bashHarness({
      requireCharter: true,
      requireExecutableCharter: true,
      charterDiscrimination: 'off',
    })
    const result = await execute(ctx, 'jspace_open', {
      goal: 'Ship charter',
      next: 'Write',
      charter: [{ kind: 'prose', constraint: 'Be kind to reviewers.' }],
    }, agent)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(OPEN_REQUIRES_EXECUTABLE_CHARTER)
  })

  it('registers a charter on an auto-opened empty card', async () => {
    const { ctx, agent, tmpDir } = await bashHarness()
    ctx.jspace.open(agent.session, { goal: 'J-Space is on', next: 'State the first action' })
    expect(ctx.jspace.card(agent.session)?.charter).toEqual([])
    await writeFile(join(tmpDir, 'src/m01-sku.js'), 'export function invSku() {}\n')
    const opened = await execute(ctx, 'jspace_open', {
      goal: 'Ship charter',
      next: 'Write modules',
      charter: [AUDIT_CHECK],
    }, agent)
    expect(opened.isError).toBe(false)
    expect(text(opened)).toBe('Updated J-Space.')
    expect(ctx.jspace.card(agent.session)?.charter).toHaveLength(1)
    expect(ctx.jspace.card(agent.session)?.goal).toBe('Ship charter')
  }, 30_000)

  it('refuses jspace_open carrying charter onto a non-empty charter', async () => {
    const { ctx, agent } = await bashHarness({
      requireCharter: true,
      requireExecutableCharter: false,
      charterDiscrimination: 'off',
    })
    await execute(ctx, 'jspace_open', {
      goal: 'Ship charter',
      next: 'Write',
      charter: [{ kind: 'prose', constraint: 'Be kind to reviewers.' }],
    }, agent)
    const again = await execute(ctx, 'jspace_open', {
      goal: 'Ship charter',
      next: 'Write more',
      charter: [{ kind: 'prose', constraint: 'Keep diffs small.' }],
    }, agent)
    expect(again.isError).toBe(true)
    expect(text(again)).toContain(CHARTER_ALREADY_REGISTERED)
    expect(ctx.jspace.card(agent.session)?.charter).toHaveLength(1)
  })

  it('refuses registration when the resulting list exceeds maxCharterEntries', async () => {
    const { ctx, agent } = await bashHarness({
      requireCharter: true,
      requireExecutableCharter: false,
      charterDiscrimination: 'off',
      maxCharterEntries: 2,
    })
    const result = await execute(ctx, 'jspace_open', {
      goal: 'Ship charter',
      next: 'Write',
      charter: [
        { kind: 'prose', constraint: 'one' },
        { kind: 'prose', constraint: 'two' },
        { kind: 'prose', constraint: 'three' },
      ],
    }, agent)
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/maxCharterEntries is 2/)
    expect(ctx.jspace.card(agent.session)).toBeNull()
  })

  it('refuses amend when the resulting list exceeds maxCharterEntries', async () => {
    const { ctx, agent } = await bashHarness({
      requireCharter: true,
      requireExecutableCharter: false,
      charterDiscrimination: 'off',
      maxCharterEntries: 2,
    })
    await execute(ctx, 'jspace_open', {
      goal: 'Ship charter',
      next: 'Write',
      charter: [
        { kind: 'prose', constraint: 'one' },
        { kind: 'prose', constraint: 'two' },
      ],
    }, agent)
    const amended = await execute(ctx, 'jspace_charter_amend', {
      add: [{ kind: 'prose', constraint: 'three' }],
    }, agent)
    expect(amended.isError).toBe(true)
    expect(text(amended)).toMatch(/maxCharterEntries is 2/)
    expect(ctx.jspace.card(agent.session)?.charter).toHaveLength(2)
  })

  it('refuses a failProbe whose resolved path escapes cwd through a symlink', async () => {
    const { ctx, agent, tmpDir } = await bashHarness()
    const outside = join(tmpDir, '..', `charter-outside-${Math.random()}`)
    await writeFile(outside, 'secret\n')
    await writeFile(join(tmpDir, 'src/m01-sku.js'), '/* AUDIT-TAG: INV-W0-A7F3 */\nexport function invSku() {}\n')
    await symlink(outside, join(tmpDir, 'src/m-probe.js'))
    const result = await execute(ctx, 'jspace_open', {
      goal: 'Ship charter',
      next: 'Write modules',
      charter: [{
        kind: 'check',
        constraint: 'first line is the audit tag',
        command: 'grep AUDIT-TAG src/m*.js',
        reads: ['src/m*.js'],
        failProbe: {
          path: 'src/m-probe.js',
          mutation: { kind: 'insert', content: '// no tag\n' },
        },
      }],
    }, agent)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(charterProbeSymlinkRefuse('src/m-probe.js'))
    expect(await readFile(outside, 'utf8')).toBe('secret\n')
    await rm(outside, { force: true })
  }, 30_000)
})

describe('charter checkpoint, ship, and amend', () => {
  it('refuses checkpoint and ship on a vacuous glob success', async () => {
    const { ctx, agent } = await bashHarness({
      requireCharter: true,
      requireExecutableCharter: true,
      charterDiscrimination: 'off',
    })
    const opened = await execute(ctx, 'jspace_open', {
      goal: 'Ship charter',
      next: 'Write modules',
      charter: [{
        kind: 'check',
        constraint: 'modules exist',
        command: 'node -e "process.exit(0)" src/m*.js',
        reads: ['src/m*.js'],
      }],
    }, agent)
    expect(opened.isError).toBe(false)
    const checked = await execute(ctx, 'jspace_checkpoint', {}, agent)
    expect(checked.isError).toBe(true)
    expect(text(checked)).toMatch(/fix:/)
    expect(text(checked)).toMatch(/e1/)
    expect(ctx.jspace.card(agent.session)?.checked).toEqual([])
  }, 30_000)

  it('synthesizes a verified checkpoint then re-runs at ship', async () => {
    const { ctx, agent, tmpDir } = await bashHarness()
    await execute(ctx, 'jspace_open', {
      goal: 'Ship charter',
      next: 'Write modules',
      charter: [AUDIT_CHECK],
    }, agent)
    await writeFile(join(tmpDir, 'src/m01-sku.js'), '/* AUDIT-TAG: INV-W0-A7F3 */\n')
    const checked = await execute(ctx, 'jspace_checkpoint', {}, agent)
    expect(checked.isError).toBe(false)
    const line = ctx.jspace.card(agent.session)?.checked[0]
    expect(line?.check).toMatch(/^charter e1/)
    expect(line?.by).toMatch(/charter-run of 1 checks/)
    expect(line?.verified).toBe(true)
    const shipped = await execute(ctx, 'jspace_ship', {}, agent)
    expect(shipped.isError).toBe(false)
    const runs = agent.session.events.filter(event => event.type === 'jspace/charter-run')
    expect(runs.some(event => event.data.phase === 'checkpoint')).toBe(true)
    expect(runs.some(event => event.data.phase === 'ship')).toBe(true)
  }, 30_000)

  it('refuses dropping the last check under requireExecutableCharter', async () => {
    const { ctx, agent } = await bashHarness()
    await execute(ctx, 'jspace_open', {
      goal: 'Ship charter',
      next: 'Write modules',
      charter: [AUDIT_CHECK],
    }, agent)
    const id = ctx.jspace.card(agent.session)?.charter[0]?.id
    expect(id).toBeDefined()
    const amended = await execute(ctx, 'jspace_charter_amend', { drop: [id] }, agent)
    expect(amended.isError).toBe(true)
    expect(text(amended)).toContain(OPEN_REQUIRES_EXECUTABLE_CHARTER)
    expect(ctx.jspace.card(agent.session)?.charter).toHaveLength(1)
  }, 30_000)

  it('amends by replacing a check and logs jspace/charter-amend', async () => {
    const { ctx, agent } = await bashHarness()
    await execute(ctx, 'jspace_open', {
      goal: 'Ship charter',
      next: 'Write modules',
      charter: [AUDIT_CHECK],
    }, agent)
    const id = String(ctx.jspace.card(agent.session)?.charter[0]?.id)
    const amended = await execute(ctx, 'jspace_charter_amend', {
      replace: [{
        id,
        entry: {
          kind: 'check',
          constraint: 'audit tag via helper path token',
          command: 'grep AUDIT-TAG src/m-probe.js',
          reads: ['src/m-probe.js'],
          failProbe: {
            path: 'src/m-probe.js',
            mutation: { kind: 'insert', content: '// no tag\n' },
          },
        },
      }],
    }, agent)
    expect(amended.isError).toBe(false)
    expect(text(amended)).toBe('Amended charter.')
    expect(agent.session.events.some(event => event.type === 'jspace/charter-amend')).toBe(true)
    expect(ctx.jspace.card(agent.session)?.charter[0]?.constraint).toContain('helper path')
  }, 30_000)
})

describe('charter composition refusals', () => {
  it('throws at apply when requireCharter meets always-open', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(JspaceService, { enabled: true, mode: 'always-open' })
    await expect(ctx.plugin(tool, { requireCharter: true })).rejects.toThrow(/always-open/)
  })

  it('throws at apply when requireExecutableCharter is set without requireCharter', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(JspaceService, { enabled: true })
    await expect(ctx.plugin(tool, { requireExecutableCharter: true }))
      .rejects.toThrow(/implies requireCharter/)
  })

  it('throws at apply when required discrimination lacks requireExecutableCharter', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(JspaceService, { enabled: true })
    await expect(ctx.plugin(tool, { requireCharter: true, charterDiscrimination: 'required' }))
      .rejects.toThrow(/implies requireExecutableCharter/)
  })

  it('fails loud when fs is missing under required discrimination', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'shres-charter-nofs-'))
    const spillDir = await mkdtemp(join(tmpdir(), 'shres-charter-nofs-spill-'))
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    ;(ctx.subprocess as LocalSubprocessRuntime).internals = { spillDir }
    await ctx.plugin(BashEnvPlugin)
    await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000, graceMs: 200 })
    await ctx.plugin(ToolBash)
    await ctx.plugin(JspaceService, { enabled: true })
    await ctx.plugin(tool, {
      requireCharter: true,
      requireExecutableCharter: true,
      charterDiscrimination: 'required',
    })
    const session = ctx.sessions.create(SessionId('ws-nofs'), { meta: { cwd: tmpDir } })
    const agent = { id: session.id, session } as unknown as Agent
    cleanups.push(async () => {
      await ctx.fiber.dispose()
      await rm(tmpDir, { recursive: true, force: true })
      await rm(spillDir, { recursive: true, force: true })
    })
    const result = await execute(ctx, 'jspace_open', {
      goal: 'Ship charter',
      next: 'Write',
      charter: [AUDIT_CHECK],
    }, agent)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(CHARTER_FS_REQUIRED)
  }, 30_000)
})
