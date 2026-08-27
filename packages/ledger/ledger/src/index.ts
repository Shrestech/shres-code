/**
 * Service Definition for the decision-ledger capability seam (`ctx.ledger`):
 * the decision record/query service contract, the required-field validation
 * and spec step, the validation failure taxonomy, the durable JSONL store, and
 * the log-only `ledger/decision` session event. Providers subclass
 * {@link LedgerService} and implement the three abstract persistence hooks;
 * the seam's concrete `record`/`query` own defaulting (via
 * {@link resolveRecord}), id allocation, evidence resolution against the
 * mounted tracker service, and event logging.
 *
 * @module @shres-code/shres-code-ledger
 */

import { Context, Service } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import { isAbsolute, join } from 'node:path'
import { shresHomePath } from '@shres-code/shres-code-home-paths'
import type { CallId } from '@shres-code/shres-code-llm'
import type { Session } from '@shres-code/shres-code-session'
import { LedgerError, newLedgerEntryId, resolveRecord } from './resolve.ts'
import { LedgerStore } from './store.ts'
import type {
  LedgerEntry,
  LedgerEntryId,
  LedgerFilter,
  LedgerRecordResult,
  LedgerRequest,
  LedgerSpec,
} from './types.ts'

export {
  LedgerError,
  newLedgerEntryId,
  resolveRecord,
} from './resolve.ts'
export { LedgerStore } from './store.ts'
export type {
  Decision,
  LedgerDecisionEvent,
  LedgerEntry,
  LedgerEntryId,
  LedgerEvidence,
  LedgerFailureReason,
  LedgerFilter,
  LedgerRecordResult,
  LedgerRequest,
  LedgerSpec,
} from './types.ts'

declare module '@shres-code/cordis' {
  interface Context {
    ledger: LedgerService
  }
}

/**
 * The abstract decision-ledger service. Registered as `ctx.ledger` (one
 * provider per context; loading a second throws cordis' standard
 * duplicate-service behavior). A provider subclasses this, implements the
 * three abstract persistence hooks, and loads the subclass as a plugin.
 *
 * Implementations must honor these semantics:
 * - {@link persistRecord} persists a resolved decision spec under its entry id.
 * - {@link queryEntries} reads the provider's authoritative entry store.
 * - {@link hasEntry} reports whether an entry id is present in the store.
 */
export abstract class LedgerService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'ledger')
  }

  /**
   * Persist a resolved decision spec under its entry id. Implemented by the
   * provider.
   * @param entryId - the id the seam allocated for this record.
   * @param spec - a resolved spec from {@link resolveRecord}, never a raw request.
   */
  abstract persistRecord(entryId: LedgerEntryId, spec: LedgerSpec): Promise<void>

  /**
   * Query entries from the provider's authoritative store.
   * @param filter - optional filters; absent fields are not applied.
   * @returns the matching entries.
   */
  abstract queryEntries(filter: LedgerFilter): Promise<LedgerEntry[]>

  /**
   * Whether the provider's store holds an entry with the given id. Synchronous
   * so the invariant companion can check a `ledger/decision` event against the
   * store without awaiting a query.
   * @param entryId - the entry id to look up.
   * @returns whether the entry is present.
   */
  abstract hasEntry(entryId: LedgerEntryId): boolean

  /**
   * Record a decision. Resolves and validates the request, allocates the entry
   * id, resolves every cited run id against the mounted tracker service, and
   * delegates to the provider. A validation or store failure returns a failed
   * result carrying the {@link LedgerFailureReason}; the log-only
   * `ledger/decision` event is written only after the provider returns, so the
   * log reflects the record outcome exactly as the caller received it.
   * @param session - owning session; the decision event is appended to its log.
   * @param request - the caller's decision request (validated and defaulted here).
   * @param callId - the tool-call id of the `ledger_record_decision` call that produced the record.
   * @returns the record outcome with the allocated entry id.
   */
  async record(session: Session, request: LedgerRequest, callId: CallId): Promise<LedgerRecordResult> {
    const entryId = newLedgerEntryId()
    let spec: LedgerSpec
    try {
      spec = resolveRecord(request)
    } catch (error) {
      if (error instanceof LedgerError) return { kind: 'failed', entryId, reason: error.code }
      throw error
    }
    const runs = await this.ctx.tracker.queryRuns({})
    const known = new Set(runs.map(run => run.runId))
    for (const runId of spec.evidence.runIds) {
      if (!known.has(runId)) return { kind: 'failed', entryId, reason: 'unresolved-run' }
    }
    try {
      await this.persistRecord(entryId, spec)
    } catch (error) {
      if (error instanceof LedgerError) return { kind: 'failed', entryId, reason: error.code }
      throw error
    }
    session.append('ledger/decision', {
      entryId,
      hypothesis: spec.hypothesis,
      decision: spec.decision,
      runIds: spec.evidence.runIds,
      callId,
    }, { ignorable: true })
    return { kind: 'recorded', entryId }
  }

  /**
   * Query entries from the provider's authoritative store.
   * @param filter - optional filters; absent fields are not applied.
   * @returns the matching entries.
   */
  async query(filter: LedgerFilter): Promise<LedgerEntry[]> {
    return this.queryEntries(filter)
  }
}

/** Provider plugin config. */
export interface Config {
  /** Absolute path of the append-only JSONL store file. */
  storagePath: string
}

/**
 * The file-backed decision-ledger provider. A Cordis Service subclass (mounted
 * as `ctx.ledger`); implements the seam's persistence hooks over the durable
 * JSONL store.
 */
export class FileLedgerService extends LedgerService {
  static Config: z<Config> = z.object({
    storagePath: z.string().required(),
  })

  /** Services required before the provider can resolve cited run ids. */
  static inject = ['tracker']

  private readonly store: LedgerStore

  /**
   * @param ctx - Cordis context.
   * @param config - resolved provider config; `storagePath` must be non-blank.
   * @throws when `storagePath` is an empty string (misconfiguration fails loud at mount).
   */
  constructor(ctx: Context, config: Config) {
    super(ctx)
    if (config.storagePath.trim().length === 0) {
      throw new Error('ledger: storagePath must be a non-empty string')
    }
    // A relative path resolves against the harness home, matching the
    // tracker spool default; the raw process cwd depends on which process
    // mounted the service and is never a stable base.
    const storagePath = isAbsolute(config.storagePath)
      ? config.storagePath
      : join(shresHomePath('ledger'), config.storagePath)
    this.store = new LedgerStore(storagePath)
  }

  /**
   * Persist a resolved decision spec under its entry id.
   * @param entryId - the id the seam allocated for this record.
   * @param spec - the resolved decision spec.
   */
  async persistRecord(entryId: LedgerEntryId, spec: LedgerSpec): Promise<void> {
    await this.store.append({
      entryId,
      hypothesis: spec.hypothesis,
      decision: spec.decision,
      evidence: spec.evidence,
      rationale: spec.rationale,
      recordedAt: Date.now(),
    })
  }

  /**
   * Query entries from the durable store.
   * @param filter - optional filters; absent fields are not applied.
   * @returns the matching entries.
   */
  async queryEntries(filter: LedgerFilter): Promise<LedgerEntry[]> {
    return this.store.query(filter)
  }

  /**
   * Whether the store holds an entry with the given id.
   * @param entryId - the entry id to look up.
   * @returns whether the entry is present.
   */
  hasEntry(entryId: LedgerEntryId): boolean {
    return this.store.has(entryId)
  }
}

export default FileLedgerService
