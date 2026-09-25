/**
 * The pluginAdmin Remote namespace: the gesture-gated mutation surface over
 * the shared plugin and skill install core for the profile this host booted.
 * It never takes a profile name from the wire, registers no tools, and
 * writes no session events. Every method is loopback-pinned through the
 * client-connection PRIVILEGED_METHODS set; the gesture gate lives HERE, in
 * the operations that spend it, because scope validation needs the
 * verb/target semantics the carrier must not learn.
 *
 * The tokens prove a begin→spend sequence scoped to one verb and target,
 * from a loopback peer, single use. They do not prove a human gesture
 * against any same-user process that can reach loopback, including a model
 * shell tool whose sandbox permits loopback network access, page script in
 * the same origin, same-user malware, or the existing self-modification
 * capability.
 * @module @shres-code/shres-code-host-plugin-admin/gateway
 */

import { randomBytes } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Service } from '@shres-code/cordis'
import type { Context } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import { PROFILE_RUNTIME_KEY } from '@shres-code/shres-code-app-boot'
import type { InstallBegin, ParkedInstall, ProfileRuntime, RollbackReport } from '@shres-code/shres-code-app-boot'
import { GestureLedger } from '@shres-code/shres-code-host-remote-control/gesture'
import { parseSkillDocument } from '@shres-code/shres-code-skill-filesystem'
import { Remote, TypertRemoteService } from '@shres-code/shres-code-typert-protocol'
import type { SkillInstallRoots } from '@shres-code/shres-code-skill-filesystem/install'
import { nodePluginAdminCore, resolveSkillRoots } from './core.ts'
import type { PluginAdminCore } from './core.ts'
import { PluginAdminError } from './errors.ts'
import type {
  InstalledSkillView,
  PluginAdminBeginRequest,
  PluginAdminConfirmOutcome,
  PluginAdminGestureVerb,
  PluginAdminInstallOutcome,
  PluginAdminInstallRequest,
  PluginAdminRemoveOutcome,
  PluginAdminRemoveRequest,
  PluginAdminSettleRequest,
  PluginAdminSkillAddRequest,
  PluginAdminSkillRemoveRequest,
  PluginAdminStatusResult,
  PluginConfirmToken,
  PluginGestureGrant,
  PluginGestureToken,
  PluginTransactionId,
  SkillInstallOutcome,
  SkillRemoveOutcome,
} from './types.ts'

/** Deployment-varying choices of the pluginAdmin surface. */
export interface PluginAdminConfig {
  /**
   * How long a parked install transaction waits for its confirm token, in
   * milliseconds; expiry cancels the transaction and rolls it back. A
   * validated Config field changeable from cordis.yml; the default matches
   * the begin-gesture window.
   */
  confirmTtlMs?: number
  /**
   * Skill install roots override; defaults to the working directory's home
   * paths. Programmatic seam for hermetic tests that must not touch the
   * user's global skill roots; the Loader never supplies it.
   */
  skillRoots?: SkillInstallRoots
}

/** Loader validation for the config fields cordis.yml may set. */
export const Config: z<PluginAdminConfig> = z.object({
  confirmTtlMs: z.natural().min(1).default(120_000),
})

/** An install transaction from the synchronous slot reservation until the core parks or refuses it. */
interface BeginningTransaction {
  phase: 'beginning'
  /** Aborted by disposal; the core treats the abort as a cancel. */
  controller: AbortController
  /** The whole install call, awaited by disposal. */
  done: Promise<unknown>
}

/** A parked install transaction awaiting (or settling) its confirm token. */
interface ParkedTransaction {
  phase: 'parked'
  transactionId: PluginTransactionId
  confirmToken: PluginConfirmToken
  install: ParkedInstall
  timer: NodeJS.Timeout | undefined
  /** Set once confirm, cancel, expiry, or disposal starts settling, so no second settle can start. */
  settling: Promise<unknown> | undefined
}

/** The one transaction slot: reserved synchronously, so two interleaved installs cannot both pass the check. */
type Transaction = BeginningTransaction | ParkedTransaction

/** Mint one 128-bit hex nonce. */
function mintHex(): string {
  return randomBytes(16).toString('hex')
}

/**
 * Whether an install spec names a local path relative to some working
 * directory (`.`, `..`, `~`, with or without a `file:`/`link:` prefix). The
 * wire has no invoking directory, so such a spec would silently resolve
 * against the server's own working directory.
 */
function isRelativePathSpec(spec: string): boolean {
  return /^(?:(?:file|link):)?(?:\.{1,2}(?:[/\\]|$)|~)/.test(spec)
}

/**
 * Serve the pluginAdmin namespace over the shared install core. At most one
 * install transaction exists at a time; it auto-cancels through the
 * configured confirm window, and disposal aborts or rolls it back and awaits
 * the settlement.
 *
 * The `profileRuntime` service is optional: a composition whose launcher did
 * not provide one (a raw Web deployment) reports `mutations: 'unsupported'`,
 * answers `unsupported` for plugin install and remove, and still serves the
 * skill operations.
 */
export class PluginAdminGateway extends TypertRemoteService {
  static inject = []

  /** Loader validation for the admin configuration. */
  static Config: z<PluginAdminConfig> = Config

  private readonly confirmTtlMs: number
  private readonly skillRoots: SkillInstallRoots
  private readonly invokingCwd: string
  private readonly core: PluginAdminCore
  private readonly gestures = new GestureLedger<PluginAdminGestureVerb>()
  private transaction: Transaction | null = null
  private readonly pending = new Set<{ controller: AbortController; done: Promise<unknown> }>()

  /**
   * @param ctx - host context carrying the optional profileRuntime service
   *   and, when present, the skills registry that powers the runtime name checks.
   * @param config - deployment overrides; every field optional.
   * @param core - shared-core seam; production resolves the app-boot and
   *   skill-filesystem functions, tests fabricate them.
   */
  constructor(ctx: Context, config?: PluginAdminConfig, core: PluginAdminCore = nodePluginAdminCore) {
    super(ctx, 'pluginAdmin')
    /* v8 ignore next -- Loader validation always supplies the Config default; the fallback serves direct construction. */
    this.confirmTtlMs = config?.confirmTtlMs ?? 120_000
    this.core = core
    this.invokingCwd = process.cwd()
    this.skillRoots = resolveSkillRoots(this.invokingCwd, config?.skillRoots)
  }

  /** The gateway owns its transaction's lifetime: unmounting aborts or rolls it back and awaits the settlement. */
  protected [Service.init](): void {
    this.ctx.effect(() => () => this.disposeTransactions(), 'plugin-admin.transactionTeardown')
  }

  /**
   * Read the plugin, skill, and parked-transaction picture for a fresh page
   * load. Without a provided profile runtime the plugin list is empty and
   * mutations are `unsupported`. Shadowing facts require the skills
   * registry; the comparison reads its global snapshot, so preset-specific
   * skill overrides are not part of it.
   * @returns the full status view.
   */
  @Remote('status')
  async status(): Promise<PluginAdminStatusResult> {
    const runtime = this.profileRuntime()
    const [plugins, skills] = await Promise.all([
      runtime === undefined ? Promise.resolve([]) : this.core.pluginStates(runtime.profileDir, runtime.bootBundles),
      this.installedSkillViews(),
    ])
    const transaction = this.transaction
    return {
      mutations: runtime?.pluginMutations ?? 'unsupported',
      plugins,
      skills,
      ...(transaction?.phase === 'parked'
        ? { parked: { transactionId: transaction.transactionId, preview: transaction.install.preview } }
        : {}),
    }
  }

  /**
   * Mint one one-shot gesture grant bound to the (verb, target) mutation.
   * @param request - the gesture to authorize.
   * @returns the token and its deadline.
   */
  @Remote('begin')
  begin(request: PluginAdminBeginRequest): PluginGestureGrant {
    if (request.target.length === 0) {
      throw new PluginAdminError('gesture-refused', `verb "${request.verb}" needs a non-empty target`)
    }
    const minted = this.gestures.mint(request.verb, request.target, Date.now())
    return { token: minted.token as PluginGestureToken, expiresAt: new Date(minted.expiresAt).toISOString() }
  }

  /**
   * Run one plugin install into the booted profile and park it for consent.
   * The transaction slot is reserved synchronously, so two interleaved
   * installs cannot both reach the core. A host without an enabled profile
   * runtime answers `unsupported` without touching anything.
   * @param request - the granted install with its package spec.
   * @returns the parked transaction, the core refusal, or `unsupported`.
   */
  @Remote('stageInstall')
  async stageInstall(request: PluginAdminInstallRequest): Promise<PluginAdminInstallOutcome> {
    // No await precedes the slot reservation below, so it still happens
    // synchronously within the call.
    this.requireGesture(request.token, 'install', request.spec)
    if (isRelativePathSpec(request.spec)) {
      throw new PluginAdminError('invalid-target', `install spec "${request.spec}" is a relative path; pass an absolute directory`)
    }
    const runtime = this.mutableRuntime()
    if (runtime === undefined) return { kind: 'unsupported' }
    this.requireFreeSlot()
    const controller = new AbortController()
    const done = this.beginInstall(runtime, request.spec, controller)
    this.transaction = { phase: 'beginning', controller, done }
    return await done
  }

  /**
   * Settle the parked transaction with its commit: composition check,
   * bundles write, journal deletion.
   * @param request - the confirm token from the parked outcome.
   * @returns the flat commit receipt or the refusal with its rollback report.
   */
  @Remote('confirm')
  async confirm(request: PluginAdminSettleRequest): Promise<PluginAdminConfirmOutcome> {
    const transaction = this.parkedFor(request.token)
    return this.settle(transaction, () => transaction.install.confirm())
  }

  /**
   * Settle the parked transaction by cancelling it: restore the profile
   * manifest and lockfile, best-effort reinstall, release the lock.
   * @param request - the confirm token from the parked outcome.
   * @returns the rollback report.
   */
  @Remote('cancel')
  async cancel(request: PluginAdminSettleRequest): Promise<RollbackReport> {
    const transaction = this.parkedFor(request.token)
    return this.settle(transaction, () => transaction.install.cancel())
  }

  /**
   * Remove one bundle package from the booted profile. A host without an
   * enabled profile runtime answers `unsupported`; an install transaction
   * holding the profile lock refuses the removal immediately instead of
   * waiting on the lock.
   * @param request - the granted remove with the package name.
   * @returns the removal outcome.
   */
  @Remote('removePlugin')
  async removePlugin(request: PluginAdminRemoveRequest): Promise<PluginAdminRemoveOutcome> {
    this.requireGesture(request.token, 'remove', request.name)
    const runtime = this.mutableRuntime()
    if (runtime === undefined) return { kind: 'unsupported' }
    this.requireFreeSlot()
    return this.track(signal => this.core.removePlugin(runtime.profileDir, request.name, {
      signal,
      invokingCwd: this.invokingCwd,
    }))
  }

  /**
   * Install one skill directory into the shared installed-skills root. The
   * host first refuses a name a runtime or bundled skill already owns — the
   * filesystem roots are checked by the core itself, and the live catalog is
   * only visible here.
   * @param request - the granted add with the source path.
   * @returns the install outcome.
   */
  @Remote('skillAdd')
  async skillAdd(request: PluginAdminSkillAddRequest): Promise<SkillInstallOutcome> {
    this.requireGesture(request.token, 'skill-add', request.path)
    const name = await this.sourceSkillName(request.path)
    if (name !== undefined) {
      const owner = await this.catalogOwnerOf(name)
      if (owner !== undefined) {
        return {
          kind: 'refused',
          code: 'name-taken',
          detail: `${owner} skill "${name}" is already live; installed skills rank lowest and would never win, so the name is refused`,
          owner,
        }
      }
    }
    return this.track(signal => this.core.addInstalledSkill(request.path, this.skillRoots, { signal }))
  }

  /**
   * Remove one installed skill; only directories carrying the provenance
   * file are managed.
   * @param request - the granted remove with the skill name.
   * @returns the removal outcome.
   */
  @Remote('skillRemove')
  async skillRemove(request: PluginAdminSkillRemoveRequest): Promise<SkillRemoveOutcome> {
    this.requireGesture(request.token, 'skill-remove', request.name)
    return this.track(() => this.core.removeInstalledSkill(request.name, this.skillRoots))
  }

  /** The launcher-provided profile runtime, when this composition has one. */
  private profileRuntime(): ProfileRuntime | undefined {
    return this.ctx.get(PROFILE_RUNTIME_KEY)
  }

  /** The profile runtime when it permits plugin mutations. */
  private mutableRuntime(): ProfileRuntime | undefined {
    const runtime = this.profileRuntime()
    return runtime?.pluginMutations === 'enabled' ? runtime : undefined
  }

  /** Refuse a plugin mutation while an install transaction owns the profile. */
  private requireFreeSlot(): void {
    if (this.transaction !== null) {
      throw new PluginAdminError('transaction-pending', 'a plugin install transaction is underway; confirm or cancel it first')
    }
  }

  /**
   * Read the transaction slot through a call boundary: the checker's property
   * narrowing cannot see the asynchronous clears disposal and settlement
   * perform, so direct reads of the field after an await look stale to it.
   */
  private transactionNow(): Transaction | null {
    return this.transaction
  }

  /** Release the slot when this beginning transaction still owns it. */
  private releaseBeginning(controller: AbortController): void {
    const slot = this.transactionNow()
    if (slot?.phase === 'beginning' && slot.controller === controller) this.transaction = null
  }

  /** Run the core's begin and park its transaction, or roll it back when disposal took the slot meanwhile. */
  private async beginInstall(runtime: ProfileRuntime, spec: string, controller: AbortController): Promise<PluginAdminInstallOutcome> {
    let begin: InstallBegin
    try {
      begin = await this.core.beginPluginInstall(runtime.profileDir, spec, {
        signal: controller.signal,
        invokingCwd: this.invokingCwd,
      })
    } catch (error) {
      this.releaseBeginning(controller)
      throw error
    }
    if (begin.kind === 'refused') {
      this.releaseBeginning(controller)
      return { kind: 'refused', refusal: begin.refusal, rollback: begin.rollback }
    }
    const slot = this.transactionNow()
    if (slot?.phase !== 'beginning' || slot.controller !== controller) {
      // Disposal cleared the reservation while the core ran. Roll the parked
      // transaction back here; disposal awaits this whole call.
      const rollback = await begin.install.cancel()
      return { kind: 'refused', refusal: { code: 'declined' }, rollback }
    }
    const transaction: ParkedTransaction = {
      phase: 'parked',
      // Branded at the minting boundary this gateway owns.
      transactionId: mintHex() as PluginTransactionId,
      confirmToken: mintHex() as PluginConfirmToken,
      install: begin.install,
      timer: undefined,
      settling: undefined,
    }
    transaction.timer = setTimeout(() => { this.expire(transaction) }, this.confirmTtlMs)
    this.transaction = transaction
    return {
      kind: 'parked',
      transactionId: transaction.transactionId,
      preview: begin.install.preview,
      confirmToken: transaction.confirmToken,
    }
  }

  /** Spend one gesture or refuse the mutation loudly. */
  private requireGesture(token: PluginGestureToken, verb: PluginAdminGestureVerb, target: string): void {
    if (!this.gestures.consume(token, verb, target, Date.now())) {
      throw new PluginAdminError('gesture-refused', `no unspent gesture token for ${verb} on "${target}"; call pluginAdmin/begin first`)
    }
  }

  /**
   * Match the confirm token to the parked transaction. A mismatched token
   * leaves the transaction parked; a transaction already settling (confirm,
   * cancel, expiry, or disposal) refuses every further settle.
   */
  private parkedFor(token: PluginConfirmToken): ParkedTransaction {
    const transaction = this.transaction
    if (transaction?.phase !== 'parked') {
      throw new PluginAdminError('no-parked-transaction', 'no install transaction is parked; call pluginAdmin/stageInstall first')
    }
    if (transaction.confirmToken !== token) {
      throw new PluginAdminError('confirm-mismatch', 'the presented token does not match the parked transaction')
    }
    if (transaction.settling !== undefined) {
      throw new PluginAdminError('transaction-pending', 'the parked transaction is already settling')
    }
    return transaction
  }

  /**
   * Start the one settle of a parked transaction: stop its expiry, run the
   * settle, and clear the slot once it finishes. The settle promise is
   * recorded so disposal awaits it instead of starting a second one.
   */
  private settle<TResult>(transaction: ParkedTransaction, run: () => Promise<TResult>): Promise<TResult> {
    clearTimeout(transaction.timer)
    const settling = (async () => {
      try {
        return await run()
      } finally {
        // A parked or settling transaction keeps the slot, so no other
        // transaction can have replaced it here.
        this.transaction = null
      }
    })()
    transaction.settling = settling
    return settling
  }

  /**
   * Cancel one parked transaction whose confirm window expired. Every settle
   * clears this timer synchronously before it starts, so the timer only fires
   * while the transaction is parked and unsettled.
   */
  private expire(transaction: ParkedTransaction): void {
    this.settle(transaction, () => transaction.install.cancel()).catch((error: unknown) => {
      this.ctx.logger.warn(`pluginAdmin: rolling back the expired install transaction failed: ${String(error)}`)
    })
  }

  /**
   * Abort every outstanding operation and the install transaction, then await
   * their settlement — a parked rollback or an in-flight settle included — so
   * disposal reaches quiescence instead of leaving a locked profile behind.
   * Failures are logged, not re-raised: disposal must finish, and the core's
   * transaction journal recovers an interrupted transaction on the next run.
   */
  private async disposeTransactions(): Promise<void> {
    const settlements: Promise<unknown>[] = []
    for (const operation of this.pending) {
      operation.controller.abort()
      settlements.push(operation.done)
    }
    const transaction = this.transaction
    if (transaction?.phase === 'beginning') {
      this.transaction = null
      transaction.controller.abort()
      settlements.push(transaction.done)
    } else if (transaction?.phase === 'parked') {
      settlements.push(transaction.settling ?? this.settle(transaction, () => transaction.install.cancel()))
    }
    for (const result of await Promise.allSettled(settlements)) {
      if (result.status === 'rejected') {
        this.ctx.logger.warn(`pluginAdmin: an operation failed while the namespace was disposed: ${String(result.reason)}`)
      }
    }
  }

  /** Run one core operation under a disposal-abortable controller and remember it until it settles. */
  private async track<TResult>(run: (signal: AbortSignal) => Promise<TResult>): Promise<TResult> {
    const controller = new AbortController()
    const done = run(controller.signal)
    const record = { controller, done }
    this.pending.add(record)
    try {
      return await done
    } finally {
      this.pending.delete(record)
    }
  }

  /** Project the installed rows onto the wire view, adding live-catalog shadowing when the registry is present. */
  private async installedSkillViews(): Promise<InstalledSkillView[]> {
    const rows = await this.core.listInstalledSkills(this.skillRoots)
    const skills = this.ctx.get('skills')
    if (skills === undefined) return rows.map(row => ({ ...row }))
    const snapshot = await skills.snapshot({ cwd: this.invokingCwd })
    const liveOwners = new Map(
      snapshot.skills
        .filter(candidate => candidate.source !== 'installed')
        .map(candidate => [candidate.name, candidate.source]),
    )
    return rows.map((row) => {
      const owner = liveOwners.get(row.name)
      return owner === undefined ? { ...row } : { ...row, shadowedBy: owner }
    })
  }

  /**
   * Source of the same-named skill that currently wins the registry's global
   * catalog snapshot — preset-specific overrides are not included — if the
   * skills registry is mounted. A same-named runtime or bundled skill is the
   * refusal reason at add time.
   */
  private async catalogOwnerOf(name: string): Promise<string | undefined> {
    const skills = this.ctx.get('skills')
    if (skills === undefined) return undefined
    const snapshot = await skills.snapshot({ cwd: this.invokingCwd })
    return snapshot.skills.find(candidate => candidate.name === name && candidate.source !== 'installed')?.source
  }

  /**
   * Read the skill name a source directory (or flat markdown file) declares,
   * through the same parser discovery and the installer use. Any unreadable
   * or invalid source yields undefined here; the core installer is the
   * authority that refuses it with an invalid-skill reason.
   */
  private async sourceSkillName(path: string): Promise<string | undefined> {
    const candidates: string[] = []
    if (path.endsWith('.md')) {
      candidates.push(path)
    } else {
      candidates.push(join(path, 'SKILL.md'))
      try {
        for (const entry of await readdir(path)) {
          if (entry.endsWith('.md') && entry !== 'SKILL.md') candidates.push(join(path, entry))
        }
      } catch {
        // Not a readable directory: the core installer refuses it with the
        // invalid-skill reason, so the pre-check simply has no name to check.
        return undefined
      }
    }
    for (const candidate of candidates) {
      try {
        return parseSkillDocument(await readFile(candidate, 'utf8')).name
      } catch {
        // Try the next candidate layout; the authority for the final verdict
        // is the core installer's refusal.
      }
    }
    return undefined
  }
}

export default PluginAdminGateway
