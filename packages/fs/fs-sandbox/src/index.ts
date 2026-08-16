/**
 * `SandboxedFileSystem`: the sandbox-enforcing implementation of the
 * `@roos-code/roos-code-fs` Service Definition. It extends `LocalFileSystem` so all
 * text-storage mechanics — resolve, stat, read/stream, list, the atomic
 * write and the read-match-write edit critical section — are the local
 * implementation's, verbatim; this package adds the per-call POLICY fence
 * on mutations and a credential read fence on content reads.
 *
 * The fence is a policy check in TRUSTED code over a MODEL-CONTROLLED path,
 * NOT a kernel boundary — the operations are the seam's own (open, rename),
 * and only the target path is untrusted, so canonicalize-then-contain is the
 * complete answer to this surface. Kernel-grade isolation of untrusted CODE
 * stays `ctx.shell`'s job (`@roos-code/roos-code-bash-sandbox`). This mirrors the
 * `code-runtime` stance: containment, not a security boundary. The residual
 * TOCTOU (an ancestor symlink swapped between the containment re-check and the
 * syscall) is narrowed by re-canonicalizing immediately before delegating and
 * is accepted for this threat model.
 *
 * Per-call policy: `read-only` denies every mutation; `workspace-write` allows
 * a mutation only when the target canonicalizes under the policy's workspace
 * root or a platform temp area (the SAME writable-root set Seatbelt grants,
 * derived from the one `writableRoots` function so bash and fs cannot drift);
 * `danger-full-access` delegates unfenced, including credential reads. Under
 * every other mode, content reads of `$ROOS_HOME/.credentials.yaml`, any
 * `*.credentials.yaml` basename, and configured {@link Config.denyReadPaths}
 * throw `FS_SANDBOX_DENIED`. A denial throws the structured
 * `FS_SANDBOX_DENIED` — no text inference is needed (unlike bash's kernel
 * stderr), because an in-process fence knows exactly what it refused. The
 * escalation retry lives in the tool layer (`@roos-code/roos-code-tool-fs`),
 * exactly as bash's does.
 *
 * @module @roos-code/roos-code-fs-sandbox
 */

import { basename, join } from 'node:path'
import { Context } from '@roos-code/cordis'
import z from '@roos-code/schemastery'
import { LocalFileSystem } from '@roos-code/roos-code-fs-local'
import type { Config as LocalConfig } from '@roos-code/roos-code-fs-local'
import { FsError } from '@roos-code/roos-code-fs'
import type { FsEditOutcome, FsEditRequest, FsTarget, FsVersion, FsWriteIntent, FsWriteOutcome } from '@roos-code/roos-code-fs'
import { resolveRoosHome } from '@roos-code/roos-code-home-paths'
import { writableRoots } from '@roos-code/roos-code-sandbox'
import type { SandboxExecutionPolicy, SandboxMode } from '@roos-code/roos-code-sandbox'
import type {} from '@roos-code/roos-code-sandbox-policy'
import { isPathUnder } from './containment.ts'

/** Managed credentials document name under the harness home, and the basename glob `*.credentials.yaml`. */
const CREDENTIALS_FILENAME = '.credentials.yaml'
const CREDENTIALS_BASENAME_SUFFIX = '.credentials.yaml'

/**
 * Plugin config: the local backend's knobs (`cwd` resolution default and
 * `diffBasisMaxBytes` overwrite-presentation bound) plus extra read-deny
 * paths. The sandbox default (mode + `workspace-write` fallback root) is NOT
 * here — `ctx.sandboxPolicy` resolves each calling session for every
 * enforcing capability.
 */
export interface Config extends LocalConfig {
  /**
   * Extra paths whose content reads are denied except under
   * `danger-full-access`. Each entry is a non-empty single-line path;
   * relative entries resolve through the backend cwd. A directory denies
   * every descendant. Default: none.
   */
  denyReadPaths?: string[]
}

/**
 * Sandbox-enforcing filesystem backend. Registers as `ctx.fs` (loading it
 * INSTEAD OF `roos-fs-local`, together with a `ctx.sandboxPolicy`, is the whole
 * swap — the model-facing tools are untouched). Its configured default mode is
 * the capability fact exposed by {@link sandboxMode}; `roos-tool-fs` resolves
 * each session's mode and cwd into a policy for every mutation, while an
 * approved escalation may stamp a strictly wider mode for one call.
 */
export class SandboxedFileSystem extends LocalFileSystem {
  static inject = ['sandboxPolicy']
  static override Config: z<Config> = z.intersect([
    LocalFileSystem.Config,
    z.object({
      denyReadPaths: z.array(z.string()).default([]),
    }),
  ])

  private readonly defaultMode: SandboxMode
  private readonly denyReadPaths: readonly string[]
  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    this.defaultMode = ctx.sandboxPolicy.defaultMode
    const extra = config.denyReadPaths as string[]
    if (extra.some(path => path.trim().length === 0 || /[\r\n]/u.test(path))) {
      throw new Error('fs-sandbox: denyReadPaths entries must be non-empty single-line strings')
    }
    this.denyReadPaths = extra
  }

  /** The deployment default mode — the capability fact the tool layer reads to advertise escalation. */
  override get sandboxMode(): SandboxMode {
    return this.defaultMode
  }

  /**
   * Fence the read by the per-call policy, then delegate. See {@link checkedTarget}.
   * @param target - the resolved target to read.
   * @param signal - aborts the read.
   * @param sandboxPolicy - the per-call mode; omit to use the deployment fallback.
   * @returns the full decoded UTF-8 content.
   */
  override async readText(
    target: FsTarget,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<string> {
    return super.readText(await this.checkedTarget(target, sandboxPolicy, 'read'), signal)
  }

  /**
   * Fence the stream by the per-call policy, then delegate. See {@link checkedTarget}.
   * @param target - the resolved target to read.
   * @param signal - aborts the stream, including between chunks.
   * @param sandboxPolicy - the per-call mode; omit to use the deployment fallback.
   * @returns the chunk iterable, decoded and validated like {@link readText}.
   */
  override async streamText(
    target: FsTarget,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<AsyncIterable<string>> {
    return super.streamText(await this.checkedTarget(target, sandboxPolicy, 'read'), signal)
  }

  /**
   * Fence the byte read by the per-call policy, then delegate. See {@link checkedTarget}.
   * @param target - the resolved target to read.
   * @param signal - aborts the read.
   * @param maxBytes - inclusive byte cap on the complete content.
   * @param sandboxPolicy - the per-call mode; omit to use the deployment fallback.
   * @returns the full raw content, at most `maxBytes` long.
   */
  override async readBytes(
    target: FsTarget,
    signal: AbortSignal | undefined,
    maxBytes: number,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<Uint8Array> {
    return super.readBytes(await this.checkedTarget(target, sandboxPolicy, 'read'), signal, maxBytes)
  }

  /**
   * Fence the write by the per-call policy, then delegate to the inherited
   * atomic write. See {@link checkedTarget}.
   * @param target - the resolved target to write.
   * @param content - the full new file content.
   * @param expected - the write intent guarding the write; omit for unconditional.
   * @param signal - aborts before atomic publication takes effect.
   * @param sandboxPolicy - the per-call mode and workspace root; omit to use
   *   the deployment fallback.
   * @returns the write outcome from the inherited backend.
   */
  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    return super.writeText(await this.checkedTarget(target, sandboxPolicy, 'write'), content, expected, signal)
  }

  /**
   * Fence the edit by the per-call policy, then delegate to the inherited
   * atomic edit. See {@link checkedTarget}.
   * @param target - the resolved target to edit.
   * @param edit - the literal search/replace request.
   * @param expected - the version guard; omit for an unconditional edit.
   * @param signal - aborts before atomic publication takes effect.
   * @param sandboxPolicy - the per-call mode and workspace root; omit to use
   *   the deployment fallback.
   * @returns the edit outcome from the inherited backend.
   */
  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    return super.editText(await this.checkedTarget(target, sandboxPolicy, 'write'), edit, expected, signal)
  }

  /**
   * Enforce the per-call policy against `target` and return the EXACT target the
   * operation must use, so the checked identity is the one delegated (no
   * check-here-read/write-there TOCTOU). `danger-full-access` returns the
   * caller's target unfenced. A `read` re-canonicalizes NOW and denies
   * `$ROOS_HOME/.credentials.yaml`, any `*.credentials.yaml` basename, and
   * configured {@link Config.denyReadPaths}. A `write` keeps the mutation
   * fence: `read-only` denies; `workspace-write` re-canonicalizes, requires
   * containment under a writable root, and returns THAT fresh target. Throws
   * the structured `FS_SANDBOX_DENIED` on refusal — the tool layer maps it to
   * the model-facing `[sandbox: …]` marker and the escalation hint.
   */
  private async checkedTarget(
    target: FsTarget,
    sandboxPolicy: SandboxExecutionPolicy | undefined,
    access: 'read' | 'write',
  ): Promise<FsTarget> {
    const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
    const { mode } = policy
    if (mode === 'danger-full-access') return target
    if (access === 'read') {
      const fresh = await this.resolve(target.displayPath)
      if (await this.isDeniedRead(fresh, target)) {
        throw new FsError(`cannot read "${target.displayPath}": file access denied under ${mode} mode`, 'FS_SANDBOX_DENIED')
      }
      return fresh
    }
    if (mode === 'read-only') {
      throw new FsError(`cannot write "${target.displayPath}": file access denied under read-only mode`, 'FS_SANDBOX_DENIED')
    }
    // workspace-write: containment on the FRESH canonical path (catches a
    // symlink ancestor swapped since the tool resolved this target), and the
    // mutation delegates with THIS fresh target — never the stale one.
    const fresh = await this.resolve(target.displayPath)
    let contained = false
    for (const root of writableRoots(policy)) {
      if (await isPathUnder(fresh.targetKey, root)) {
        contained = true
        break
      }
    }
    if (!contained) {
      throw new FsError(`cannot write "${target.displayPath}": file access denied under workspace-write mode`, 'FS_SANDBOX_DENIED')
    }
    return fresh
  }

  /**
   * Whether a freshly re-canonicalized target is a credential document or an
   * extra deny path. Basename matching covers `*.credentials.yaml` on the
   * requested path and the resolved identity; the home document is also
   * matched by filesystem identity so a symlink alias cannot bypass it.
   */
  private async isDeniedRead(fresh: FsTarget, requested: FsTarget): Promise<boolean> {
    const names = [basename(String(fresh.targetKey)), basename(fresh.displayPath), basename(requested.displayPath)]
    if (names.some(name => name.endsWith(CREDENTIALS_BASENAME_SUFFIX))) return true

    const homeTarget = await this.resolve(join(resolveRoosHome(), CREDENTIALS_FILENAME))
    if (fresh.targetKey === homeTarget.targetKey) return true
    if (await isPathUnder(String(fresh.targetKey), String(homeTarget.targetKey))) return true

    for (const deny of this.denyReadPaths) {
      const denied = await this.resolve(deny)
      if (fresh.targetKey === denied.targetKey) return true
      if (await isPathUnder(String(fresh.targetKey), String(denied.targetKey))) return true
    }
    return false
  }
}

export default SandboxedFileSystem
