/**
 * Tests for the sandbox-enforcing filesystem backend: the per-call policy fence
 * on write/edit (read-only denies, workspace-write contains, danger-full-access
 * passes through), reads always passing through, the capability fact, and the
 * containment matrix — `..` traversal, absolute paths outside, and symlink
 * escapes (a symlinked directory inside the workspace pointing out, and a new
 * file created under one). The fence is exercised on a real filesystem: a
 * denied write leaves no file on disk.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { Context } from '@roos-code/cordis'
import { FsError, FsTargetKey } from '@roos-code/roos-code-fs'
import type { FsTarget } from '@roos-code/roos-code-fs'
import SandboxPolicyService from '@roos-code/roos-code-sandbox-policy'
import type { SandboxMode } from '@roos-code/roos-code-sandbox'
import { SandboxedFileSystem } from '@roos-code/roos-code-fs-sandbox'
import type { Config as FsSandboxConfig } from '@roos-code/roos-code-fs-sandbox'
import { resolveRoosHome } from '@roos-code/roos-code-home-paths'

let base: string
let workspace: string
let outside: string
let ctx: Context
let fs: SandboxedFileSystem
let fiber: Awaited<ReturnType<Context['plugin']>>

async function boot(mode: SandboxMode, config: FsSandboxConfig = {}): Promise<void> {
  ctx = new Context()
  await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: workspace })
  fiber = await ctx.plugin(SandboxedFileSystem, { cwd: workspace, ...config })
  fs = ctx.fs as SandboxedFileSystem
}

beforeEach(async () => {
  // Base under HOME, deliberately NOT tmpdir: `workspace-write` grants /tmp and
  // os.tmpdir() (parity with the bash runner), so an "outside" dir under tmpdir
  // would be legitimately writable. Sibling dirs under HOME are outside every
  // grant, so containment failures are real denials. (The bwrap e2e roots its
  // workspaces under HOME for the same reason.)
  base = await mkdtemp(join(homedir(), '.roos-fssbx-'))
  workspace = join(base, 'ws')
  outside = join(base, 'out')
  await mkdir(workspace)
  await mkdir(outside)
})
afterEach(async () => {
  await fiber?.dispose()
  await rm(base, { recursive: true, force: true })
})

/** Resolve a path through the backend and return its target. */
function target(path: string): Promise<FsTarget> {
  return fs.resolve(path)
}

describe('the capability fact', () => {
  it('reports the deployment default mode (what the tool layer advertises against)', async () => {
    await boot('workspace-write')
    expect(fs.sandboxMode).toBe('workspace-write')
  })
})

describe('read-only', () => {
  beforeEach(() => boot('read-only'))

  it('denies write, leaving no file on disk', async () => {
    const path = join(workspace, 'denied.txt')
    await expect(fs.writeText(await target(path), 'x')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(path)).toBe(false)
  })

  it('denies edit of an existing file (the content is unchanged)', async () => {
    const path = join(workspace, 'file.txt')
    await writeFile(path, 'original')
    await expect(fs.editText(await target(path), { oldString: 'original', newString: 'changed', replaceAll: false }))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(await readFile(path, 'utf8')).toBe('original')
  })

  it('allows reads (every mode permits reading)', async () => {
    const path = join(workspace, 'readable.txt')
    await writeFile(path, 'hello')
    expect(await fs.readText(await target(path))).toBe('hello')
  })
})

describe('workspace-write containment', () => {
  beforeEach(() => boot('workspace-write'))

  it('a write under the workspace lands', async () => {
    const path = join(workspace, 'nested', 'ok.txt')
    const outcome = await fs.writeText(await target(path), 'inside')
    expect(outcome.operation).toBe('create')
    expect(await readFile(path, 'utf8')).toBe('inside')
  })

  it('a write to the platform temp area lands (parity with the bash runner grant)', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'roos-fssbx-tmp-')), 'temp.txt')
    await fs.writeText(await target(path), 'temp')
    expect(await readFile(path, 'utf8')).toBe('temp')
  })

  it('an absolute path outside the workspace is denied, no file created', async () => {
    const path = join(outside, 'escape.txt')
    await expect(fs.writeText(await target(path), 'x')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(path)).toBe(false)
  })

  it('a `..` traversal out of the workspace is denied', async () => {
    const path = join(workspace, '..', 'sibling-escape.txt')
    await expect(fs.writeText(await target(path), 'x')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(join(workspace, '..', 'sibling-escape.txt'))).toBe(false)
  })

  it('a symlinked directory inside the workspace pointing OUT is denied (canonicalized before containment)', async () => {
    // workspace/link -> outside ; writing workspace/link/f.txt would land in outside/f.txt.
    await symlink(outside, join(workspace, 'link'))
    const path = join(workspace, 'link', 'f.txt')
    await expect(fs.writeText(await target(path), 'x')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(join(outside, 'f.txt'))).toBe(false)
  })

  it('a NEW file created under a symlinked-out directory is denied (deepest-ancestor realpath)', async () => {
    await symlink(outside, join(workspace, 'link'))
    const path = join(workspace, 'link', 'newdir', 'deep.txt')
    await expect(fs.writeText(await target(path), 'x')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(join(outside, 'newdir'))).toBe(false)
  })

  it('an edit outside the workspace is denied; the original is untouched', async () => {
    const path = join(outside, 'file.txt')
    await writeFile(path, 'original')
    await expect(fs.editText(await target(path), { oldString: 'original', newString: 'x', replaceAll: false }))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(await readFile(path, 'utf8')).toBe('original')
  })

  it('an edit inside the workspace lands', async () => {
    const path = join(workspace, 'edit.txt')
    await writeFile(path, 'original')
    const outcome = await fs.editText(await target(path), { oldString: 'original', newString: 'changed', replaceAll: false })
    expect(outcome.after).toBe('changed')
    expect(await readFile(path, 'utf8')).toBe('changed')
  })

  it('mutates the freshly checked identity, not a stale outside targetKey (TOCTOU direction)', async () => {
    // A target whose displayPath is inside the workspace but whose targetKey is
    // a STALE outside path — as if an ancestor symlink pointed out at the tool's
    // resolve() and was swapped in before the write. The fence re-resolves
    // displayPath (now inside) AND delegates with that fresh target, so the byte
    // lands inside and the stale outside path is never written.
    const insidePath = join(workspace, 'landed.txt')
    const staleTarget: FsTarget = { displayPath: insidePath, targetKey: FsTargetKey(join(outside, 'escaped.txt')) }
    await fs.writeText(staleTarget, 'inside')
    expect(await readFile(insidePath, 'utf8')).toBe('inside')
    expect(existsSync(join(outside, 'escaped.txt'))).toBe(false)
  })

  it('the workspace root itself passes the fence (path equal to a writable root), failing only on file type', async () => {
    // isUnder's path-equals-root branch: the fence allows the root, and the
    // write then fails because the root is a directory, not a regular file.
    await expect(fs.writeText(await target(workspace), 'x')).rejects.toMatchObject({ code: 'FS_NOT_REGULAR_FILE' })
  })
})

describe('workspace-write with the filesystem root as the workspace (a root ending in the path separator)', () => {
  it('grants writes anywhere on that volume', async () => {
    // A degenerate but valid config: the filesystem root containing the target.
    // It exercises the separator-suffixed-root branch on POSIX and Windows.
    const rootCtx = new Context()
    await rootCtx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: parse(base).root })
    const rootFiber = await rootCtx.plugin(SandboxedFileSystem, { cwd: workspace })
    const rootFs = rootCtx.fs as SandboxedFileSystem
    try {
      const path = join(base, 'anywhere.txt') // under HOME, outside temp — allowed only via the filesystem root
      await rootFs.writeText(await rootFs.resolve(path), 'anywhere')
      expect(await readFile(path, 'utf8')).toBe('anywhere')
    } finally {
      await rootFiber.dispose()
    }
  })
})

describe('danger-full-access', () => {
  beforeEach(() => boot('danger-full-access'))

  it('writes anywhere, unfenced', async () => {
    const path = join(outside, 'free.txt')
    await fs.writeText(await target(path), 'free')
    expect(await readFile(path, 'utf8')).toBe('free')
  })
})

describe('the per-call policy override (escalation)', () => {
  it('a workspace-write stamp on a read-only default lets a contained write land for that call only', async () => {
    await boot('read-only')
    const path = join(workspace, 'escalated.txt')
    // Default read-only would deny; the per-call workspace-write policy allows it (contained).
    await fs.writeText(await target(path), 'granted', undefined, undefined, { mode: 'workspace-write', workspaceRoot: workspace })
    expect(await readFile(path, 'utf8')).toBe('granted')
    // A neighboring plain call still runs under the read-only default.
    await expect(fs.writeText(await target(join(workspace, 'plain.txt')), 'x'))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it('a danger-full-access stamp bypasses the fence for that call', async () => {
    await boot('read-only')
    const path = join(outside, 'granted-full.txt')
    await fs.writeText(await target(path), 'full', undefined, undefined, { mode: 'danger-full-access', workspaceRoot: workspace })
    expect(await readFile(path, 'utf8')).toBe('full')
  })
})

describe('registration and HMR safety', () => {
  it('registers as ctx.fs and unregisters cleanly from a child fiber', async () => {
    await boot('workspace-write')
    expect(ctx.fs).toBeInstanceOf(SandboxedFileSystem)
    await fiber.dispose()
    expect(ctx.get('fs')).toBeUndefined()
    // Re-mount below the disposed one to prove no lingering registration.
    fiber = await ctx.plugin(SandboxedFileSystem, { cwd: workspace })
    expect(ctx.fs).toBeInstanceOf(SandboxedFileSystem)
  })
})

describe('the credential read fence', () => {
  const previousHome = process.env.ROOS_HOME
  let home: string

  beforeEach(async () => {
    home = join(base, 'roos-home')
    await mkdir(home)
    process.env.ROOS_HOME = home
  })
  afterEach(() => {
    if (previousHome === undefined) delete process.env.ROOS_HOME
    else process.env.ROOS_HOME = previousHome
  })

  it('denies a direct read of $ROOS_HOME/.credentials.yaml under workspace-write', async () => {
    await boot('workspace-write')
    const path = join(resolveRoosHome(), '.credentials.yaml')
    await writeFile(path, 'DEEPSEEK_API_KEY: sk-secret\n', { mode: 0o600 })
    await expect(fs.readText(await target(path))).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it('denies streamText and readBytes of a workspace *.credentials.yaml file', async () => {
    await boot('workspace-write')
    const path = join(workspace, 'provider.credentials.yaml')
    await writeFile(path, 'secret: value\n')
    const resolved = await target(path)
    await expect(fs.streamText(resolved)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    await expect(fs.readBytes(resolved, undefined, 1024)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it('denies the resolved identity of $ROOS_HOME/.credentials.yaml even when the target basename is harmless', async () => {
    const real = join(outside, 'secret-store')
    await writeFile(real, 'sk-hidden\n')
    await symlink(real, join(resolveRoosHome(), '.credentials.yaml'))
    await boot('workspace-write')
    await expect(fs.readText(await target(real))).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it('denies a symlink alias that resolves to the home credentials document', async () => {
    await boot('workspace-write')
    const real = join(resolveRoosHome(), '.credentials.yaml')
    await writeFile(real, 'DEEPSEEK_API_KEY: sk-secret\n', { mode: 0o600 })
    const alias = join(workspace, 'not-secrets.txt')
    await symlink(real, alias)
    await expect(fs.readText(await target(alias))).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it('denies a configured extra deny path, including through a symlink alias', async () => {
    const extra = join(outside, 'token')
    await writeFile(extra, 'sk-extra\n')
    await boot('workspace-write', { denyReadPaths: [extra] })
    await expect(fs.readText(await target(extra))).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    const alias = join(workspace, 'token-alias')
    await symlink(extra, alias)
    await expect(fs.readText(await target(alias))).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it('still allows ordinary workspace reads', async () => {
    await boot('workspace-write')
    const path = join(workspace, 'notes.txt')
    await writeFile(path, 'hello')
    expect(await fs.readText(await target(path))).toBe('hello')
  })

  it('allows a workspace read that is not under any extra deny path', async () => {
    const extra = join(outside, 'other-secret')
    await writeFile(extra, 'sk-other\n')
    await boot('workspace-write', { denyReadPaths: [extra] })
    const path = join(workspace, 'notes.txt')
    await writeFile(path, 'hello')
    expect(await fs.readText(await target(path))).toBe('hello')
  })

  it('lifts the read fence only under danger-full-access', async () => {
    await boot('danger-full-access')
    const path = join(resolveRoosHome(), '.credentials.yaml')
    await writeFile(path, 'DEEPSEEK_API_KEY: sk-secret\n', { mode: 0o600 })
    expect(await fs.readText(await target(path))).toBe('DEEPSEEK_API_KEY: sk-secret\n')
  })

  it('lifts the read fence for one call stamped danger-full-access', async () => {
    await boot('workspace-write')
    const path = join(workspace, 'provider.credentials.yaml')
    await writeFile(path, 'secret: value\n')
    expect(await fs.readText(await target(path), undefined, { mode: 'danger-full-access', workspaceRoot: workspace }))
      .toBe('secret: value\n')
    await expect(fs.readText(await target(path))).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it('denies descendants of a configured deny directory', async () => {
    const dir = join(outside, 'secrets')
    await mkdir(dir)
    const file = join(dir, 'key.txt')
    await writeFile(file, 'sk-dir\n')
    await boot('workspace-write', { denyReadPaths: [dir] })
    await expect(fs.readText(await target(file))).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it('denies a nested path when $ROOS_HOME/.credentials.yaml is a directory', async () => {
    const credsDir = join(resolveRoosHome(), '.credentials.yaml')
    await mkdir(credsDir)
    const nested = join(credsDir, 'nested.key')
    await writeFile(nested, 'sk-nested\n')
    await boot('workspace-write')
    await expect(fs.readText(await target(nested))).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it('rejects empty or multiline denyReadPaths at load', async () => {
    const root = new Context()
    await root.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: workspace })
    await expect(root.plugin(SandboxedFileSystem, { cwd: workspace, denyReadPaths: [''] }))
      .rejects.toThrow(/denyReadPaths entries must be non-empty single-line strings/)
    await expect(root.plugin(SandboxedFileSystem, { cwd: workspace, denyReadPaths: ['  '] }))
      .rejects.toThrow(/denyReadPaths entries must be non-empty single-line strings/)
    await expect(root.plugin(SandboxedFileSystem, { cwd: workspace, denyReadPaths: ['ok\nno'] }))
      .rejects.toThrow(/denyReadPaths entries must be non-empty single-line strings/)
    await expect(root.plugin(SandboxedFileSystem, { cwd: workspace, denyReadPaths: ['ok\rno'] }))
      .rejects.toThrow(/denyReadPaths entries must be non-empty single-line strings/)
  })
})

describe('FsError identity', () => {
  it('the denial is a structured FsError distinct from a host permission error', async () => {
    await boot('read-only')
    const error = await fs.writeText(await target(join(workspace, 'x.txt')), 'x').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(FsError)
    expect((error as FsError).code).toBe('FS_SANDBOX_DENIED')
  })
})
