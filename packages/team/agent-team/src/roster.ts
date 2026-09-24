/** Team membership, continuable-child provisioning, and roster-owned teardown. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@shres-code/cordis'
import type { Agent } from '@shres-code/shres-code-agent'
import type {} from '@shres-code/shres-code-tools'
import type { MessageId } from '@shres-code/shres-code-llm'
import { SessionId } from '@shres-code/shres-code-session'
import { effectiveAgentRoute, foldSubagentDescriptor } from '@shres-code/shres-code-subagent'
import type { ContinuableStart } from '@shres-code/shres-code-subagent'
import { errorMessage, TeamError } from './error.ts'
import type { TeamJournal } from './journal.ts'
import type { TeamRuntimeLifecycle } from './lifecycle.ts'
import { readPersistedSession } from './persisted.ts'
import { messageAccepted } from './session-message.ts'
import { TeamId } from './brand.ts'
import type { TeamState } from './types.ts'
import type {
  SpawnTeammateRequest,
  SpawnTeammateResult,
  TeamMemberSnapshot,
  TeamMemberView,
} from './types.ts'
import { requiredText } from './validation.ts'

const MEMBER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/** Named product-seat tools teammates must not execute, even if bound later. */
export const SEAT_TOOL_NAMES = ['aegis', 'stride', 'ward'] as const

/**
 * Deny named seat tools on a teammate after catalog remount.
 * @param execution - pending tool call.
 * @returns a denial reason, or undefined to leave the call unchanged.
 */
export function teammateSeatGuard(execution: { readonly name: string }): string | undefined {
  if ((SEAT_TOOL_NAMES as readonly string[]).includes(execution.name)) {
    return 'teammates do not have named seat tools; use team_send'
  }
  return undefined
}

/**
 * Project a resolved route onto {@link TeamMemberView} fields.
 * @param route - known provider/model fields.
 * @returns `agentProvider` / `model` view fields for the known values.
 */
function routeFields(route: { provider?: string; model?: string }): Pick<TeamMemberView, 'agentProvider' | 'model'> {
  return {
    ...route.provider === undefined ? {} : { agentProvider: route.provider },
    ...route.model === undefined ? {} : { model: route.model },
  }
}

/** Caller identity inside one implicit Team. */
export interface TeamMembership {
  readonly root: Agent
  readonly id: TeamId
  readonly role: 'lead' | 'teammate'
  readonly name: string
}

/**
 * Resolve one active Team member by model-facing name, including the Lead pseudo-row.
 * @param root - exact live Team Lead.
 * @param state - current Team state.
 * @param rawName - candidate member name or session id.
 * @returns resolved durable id and normalized name.
 */
export function resolveActiveMember(
  root: Agent,
  state: TeamState,
  rawName: string,
): { id: SessionId; name: string } {
  const name = rawName.trim()
  if (name === 'lead' || name === String(root.id)) return { id: root.id, name: 'lead' }
  const member = state.members.find(candidate => candidate.name === name || String(candidate.id) === name)
  if (member === undefined || member.phase !== 'active') {
    throw new TeamError(`active teammate "${name}" not found`, 'TEAM_MEMBER_NOT_FOUND')
  }
  return { id: member.id, name: member.name }
}

/** Owns Team identities and the lifecycle of rostered continuable children. */
export class TeamRoster {
  private readonly inFlightCreations = new Set<Promise<unknown>>()
  private readonly inFlightByName = new Map<string, Promise<SpawnTeammateResult>>()

  /**
   * @param ctx - Team service context with Agent, Session, persistence, and subagent services.
   * @param journal - authoritative Lead-log transaction owner.
   * @param lifecycle - shared Team runtime admission cutoff.
   * @param maxMembers - maximum immutable roster entries per Team.
   */
  constructor(
    private readonly ctx: Context,
    private readonly journal: TeamJournal,
    private readonly lifecycle: TeamRuntimeLifecycle,
    private readonly maxMembers: number,
  ) {}

  /**
   * Resolve one exact live Agent's Team role.
   * @param agent - exact live Agent used as the authority credential.
   * @returns its root, Team identity, role, and model-facing name.
   */
  membership(agent: Agent): TeamMembership {
    const membership = this.tryMembership(agent)
    if (membership === undefined) {
      throw new TeamError(`agent "${agent.id}" is not a member of an active Agent Team`, 'TEAM_NOT_MEMBER')
    }
    return membership
  }

  /**
   * Resolve a caller without throwing for scoped installation and lifecycle observers.
   * @param agent - candidate exact live Agent.
   * @returns Team membership, or undefined for non-Team subagents and stale identities.
   */
  tryMembership(agent: Agent): TeamMembership | undefined {
    if (this.ctx.agents.get(agent.id) !== agent) return undefined
    try {
      const parentId = agent.session.header.parentSession
      if (parentId !== undefined) {
        const root = this.ctx.agents.get(parentId)
        if (root !== undefined) {
          const member = this.journal.state(root).members.find(candidate => candidate.id === agent.id)
          if (member?.phase === 'active' || member?.phase === 'provisioning') {
            return { root, id: TeamId(root.id), role: 'teammate', name: member.name }
          }
          /* v8 ignore start -- a live child of the Lead that is not on the Team roster. */
          if (this.subagentDescriptor(agent)) return undefined
          return { root: agent, id: TeamId(agent.id), role: 'lead', name: 'lead' }
          /* v8 ignore stop */
        }
      }
      /* v8 ignore next -- a subagent child whose parent is no longer live. */
      if (this.subagentDescriptor(agent)) return undefined
      return { root: agent, id: TeamId(agent.id), role: 'lead', name: 'lead' }
    } catch {
      /* v8 ignore next -- projection or header read failed; treat as not a member. */
      return undefined
    }
  }

  /**
   * List the runtime-enriched roster visible to one Team member.
   * @param membership - exact caller membership resolved by this roster.
   * @returns Lead and teammate rows in creation order.
   */
  list(membership: TeamMembership): TeamMemberView[] {
    const { root } = membership
    const state = this.journal.state(root)
    const result: TeamMemberView[] = [{
      id: root.id,
      name: 'lead',
      role: 'lead',
      status: root.status,
      ...routeFields(effectiveAgentRoute(root)),
      diagnostics: [],
    }]
    for (const member of state.members) {
      const live = this.ctx.agents.get(member.id)
      result.push({
        id: member.id,
        name: member.name,
        role: 'teammate',
        status: member.phase === 'failed'
          ? 'failed'
          : member.phase === 'provisioning'
            ? 'provisioning'
            : live?.status ?? 'inactive',
        description: member.description,
        provider: member.provider,
        context: member.context,
        ...routeFields(this.teammateRoute(member, live)),
        diagnostics: member.error === undefined ? [] : [member.error],
      })
    }
    return result
  }

  /**
   * A teammate row's route. A loaded child reports its latest request header,
   * else its creation options — the descriptor route it was created or
   * resumed with — so a child that has not yet made a request never reports
   * the deployment default. An unloaded child reports the route its `active`
   * snapshot recorded; a snapshot without one reports none rather than the
   * Lead's route.
   */
  private teammateRoute(
    member: TeamMemberSnapshot,
    live: Agent | undefined,
  ): { provider?: string; model?: string } {
    if (live === undefined) {
      return {
        ...member.agentProvider === undefined ? {} : { provider: member.agentProvider },
        ...member.agentModel === undefined ? {} : { model: member.agentModel },
      }
    }
    const logged = live.session.requestHeader()?.config
    if (logged !== undefined) return { provider: logged.provider, model: logged.model }
    return {
      ...live.options.provider === undefined ? {} : { provider: live.options.provider },
      ...live.options.model === undefined ? {} : { model: live.options.model },
    }
  }

  /**
   * Create one named, continuable direct child of the Team Lead.
   * Concurrent callers for the same Lead and name share one creation; a later
   * call after that name is already on the roster still fails `TEAM_MEMBER_NAME_TAKEN`.
   * @param caller - exact live Lead Agent.
   * @param request - immutable name, description, prompt, context mode, provider, optional persona and cwd, and cancellation.
   * @returns the active roster row.
   */
  async spawn(caller: Agent, request: SpawnTeammateRequest): Promise<SpawnTeammateResult> {
    /* v8 ignore next -- spawn after the runtime admission cutoff. */
    if (this.lifecycle.disposed) throw new TeamError('Agent Teams service is disposing', 'TEAM_DISPOSED')
    const membership = this.membership(caller)
    if (membership.role !== 'lead') {
      throw new TeamError('only the Team Lead can create teammates', 'TEAM_LEAD_REQUIRED')
    }
    const key = this.creationKey(membership.root.id, request.name)
    const pending = this.inFlightByName.get(key)
    if (pending !== undefined) return await pending
    const operation = this.spawnAdmitted(caller, request)
    this.inFlightByName.set(key, operation)
    this.inFlightCreations.add(operation)
    try {
      return await operation
    } finally {
      this.inFlightCreations.delete(operation)
      this.inFlightByName.delete(key)
    }
  }

  /**
   * Await an in-flight same-name creation on this Lead, if one exists.
   * @param root - exact live Team Lead.
   * @param name - model-facing teammate name.
   */
  async waitForCreation(root: Agent, name: string): Promise<void> {
    const pending = this.inFlightByName.get(this.creationKey(root.id, name))
    if (pending !== undefined) await pending
  }

  /** Key in-flight creations by Lead identity and trimmed teammate name. */
  private creationKey(rootId: SessionId, rawName: string): string {
    return `${rootId}:${rawName.trim()}`
  }

  /**
   * Hide named seat tools from a teammate. Only names that are actually
   * registered as global tools are denied, so an unbound seat is omitted.
   * @returns a deny filter, or undefined when no seat tools are mounted.
   */
  private teammateToolFilter(): { readonly deny: string[] } | undefined {
    const tools = this.ctx.get('tools')
    /* v8 ignore next -- Team spawn in product trees has the tool registry; unbound seats already yield an empty deny. */
    if (tools === undefined) return undefined
    const deny = SEAT_TOOL_NAMES.filter(name =>
      tools.schemas().some(schema => schema.name === name))
    if (deny.length === 0) return undefined
    return { deny }
  }

  /**
   * Return admitted creation operations captured for ordered disposal.
   * @returns detached snapshot ordered only by Set insertion.
   */
  pendingCreations(): readonly Promise<unknown>[] {
    return [...this.inFlightCreations]
  }

  /**
   * Reconcile provisioning state when one Team member Session starts.
   * @param agent - newly started exact live Agent.
   * @param signal - shared runtime cancellation.
   */
  async recoverFor(agent: Agent, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const membership = this.tryMembership(agent)
    if (membership?.role === 'lead') await this.reconcileProvisioning(membership.root, signal)
  }

  /**
   * Release exact teammate activation forests through the continuation owner.
   * @param root - exact live Team Lead authorizing release.
   * @param childIds - selected roster child ids.
   */
  async stopTeammates(root: Agent, childIds: readonly SessionId[]): Promise<void> {
    await this.lifecycle.withTimeout((async () => {
      for (const childId of childIds) {
        const live = this.ctx.agents.get(childId)
        /* v8 ignore start -- drain a child that materialized before the creator failed. */
        if (live === undefined) continue
        this.ctx.subagents.interrupt(childId, { kind: 'ancestor', agent: root })
        // Release tracked descendants through the continuation owner so they
        // tear down child-first instead of leaking behind a direct cancel.
        await this.ctx.subagents.drainContinuableDescendants([live])
        live.cancel({ kind: 'parent' })
        /* v8 ignore stop */
      }
    })())
  }

  /** Perform one creation admitted before the Team runtime disposal cutoff. */
  private async spawnAdmitted(
    caller: Agent,
    request: SpawnTeammateRequest,
  ): Promise<SpawnTeammateResult> {
    const membership = this.membership(caller)
    const signal = AbortSignal.any([request.signal, this.lifecycle.signal])
    signal.throwIfAborted()
    const root = membership.root
    const name = this.memberName(request.name)
    const description = requiredText(request.description, 'description', 200)
    const childId = SessionId(randomUUID())
    const member: TeamMemberSnapshot = {
      id: childId,
      name,
      description,
      provider: requiredText(request.provider, 'provider', 200),
      context: request.context,
      phase: 'provisioning',
    }

    await this.journal.transact(root.id, async () => {
      const state = this.journal.state(root)
      if (state.members.some(row => row.name === name)) {
        throw new TeamError(`teammate name "${name}" was already used in this Team`, 'TEAM_MEMBER_NAME_TAKEN')
      }
      if (state.members.length >= this.maxMembers) {
        throw new TeamError(`Team member limit ${this.maxMembers} reached`, 'TEAM_MEMBER_LIMIT')
      }
      await this.journal.appendAndFlush(root.session, 'team/member', { teamId: TeamId(root.id), member })
    })

    const toolFilter = this.teammateToolFilter()
    let started: ContinuableStart
    try {
      started = await this.ctx.subagents.startContinuable({
        childId,
        provider: request.provider,
        label: description,
        request: {
          prompt: [...request.prompt],
          parent: root,
          ...request.agentOptions !== undefined ? { agentOptions: request.agentOptions } : {},
          ...request.persona !== undefined ? { persona: request.persona } : {},
          ...request.cwd !== undefined ? { cwd: request.cwd } : {},
          ...request.source !== undefined ? { source: request.source } : {},
          ...toolFilter !== undefined ? { toolFilter } : {},
        },
        signal,
      })
      await this.checkpointInitialPrompt(childId, started.messageId, signal)
    } catch (error: unknown) {
      const failed: TeamMemberSnapshot = {
        ...member,
        phase: 'failed',
        error: errorMessage(error),
      }
      try {
        const phase = await this.settleProvisioning(root, failed)
        await this.stopTeammates(root, [childId])
        /* v8 ignore next 8 -- recovery committed `active` while this creator observed failure. */
        if (phase === 'active') {
          throw new TeamError(
            `teammate "${name}" became active while its creator reported failure`,
            'TEAM_PROVISIONING_CONFLICT',
            { cause: error },
          )
        }
      } catch (recordError: unknown) {
        /* v8 ignore next -- durable failure recording itself rejected. */
        throw new AggregateError([error, recordError], 'teammate creation and durable failure recording both failed')
      }
      throw error
    }
    const active = {
      ...member,
      phase: 'active' as const,
      ...started.route.provider === undefined ? {} : { agentProvider: started.route.provider },
      ...started.route.model === undefined ? {} : { agentModel: started.route.model },
    } satisfies TeamMemberSnapshot
    const settledPhase = await this.settleProvisioning(root, active)
    /* v8 ignore start -- recovery committed `failed` while this creator was still running. */
    if (settledPhase === 'failed') {
      const conflict = new TeamError(
        `teammate "${name}" was reconciled as failed while creation was in progress`,
        'TEAM_PROVISIONING_CONFLICT',
      )
      try {
        await this.stopTeammates(root, [childId])
      } catch (cleanupError: unknown) {
        throw new AggregateError([conflict, cleanupError], 'provisioning conflict cleanup failed')
      }
      throw conflict
    }
    /* v8 ignore stop */
    return { member: this.memberView(active) }
  }

  /** Flush the accepted initial inbox item before the Lead can commit `active`. */
  private async checkpointInitialPrompt(
    childId: SessionId,
    messageId: MessageId,
    signal: AbortSignal,
  ): Promise<void> {
    while (true) {
      signal.throwIfAborted()
      const session = this.ctx.sessions.get(childId)
      /* v8 ignore start -- the child left the live store before its initial prompt flushed. */
      if (session === undefined) {
        const stored = await readPersistedSession(this.ctx.sessionPersistence, childId, signal)
        const suffix = stored.events.slice(stored.inheritedEventCount)
        if (messageAccepted(suffix, message => message.id === messageId)) return
        throw new TeamError(
          `teammate "${childId}" initial prompt was not durably accepted`,
          'TEAM_PROVISIONING_CONFLICT',
        )
      }
      /* v8 ignore stop */

      /* v8 ignore start -- wait for a later session event when the initial prompt is not yet accepted. */
      const progress = Promise.withResolvers<void>()
      void progress.promise.catch(() => undefined)
      const stopEvent = this.ctx.on('session/event', (candidate) => {
        if (candidate === session) progress.resolve()
      })
      const stopDisposed = this.ctx.on('session/disposed', (candidate) => {
        if (candidate === session) progress.resolve()
      })
      const onAbort = (): void => {
        const reason: unknown = signal.reason
        progress.reject(reason instanceof Error
          ? reason
          : new TeamError(`teammate creation aborted: ${errorMessage(reason)}`, 'TEAM_DISPOSED'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        signal.throwIfAborted()
        await this.ctx.sessions.flush(session)
        const suffix = session.events.slice(session.header.seedLength ?? 0)
        if (messageAccepted(suffix, message => message.id === messageId)) return
        if (this.ctx.sessions.get(childId) !== session) continue
        await progress.promise
      } finally {
        signal.removeEventListener('abort', onAbort)
        stopDisposed()
        stopEvent()
      }
      /* v8 ignore stop */
    }
  }

  /** Settle provisioning-only members from their independently durable child Sessions. */
  private async reconcileProvisioning(root: Agent, signal: AbortSignal): Promise<void> {
    const provisioning = this.journal.state(root).members.filter(member => member.phase === 'provisioning')
    for (const member of provisioning) {
      signal.throwIfAborted()
      /* v8 ignore next -- a live child still occupies the provisioning row. */
      if (this.ctx.agents.get(member.id) !== undefined) continue
      let phase: 'active' | 'failed' = 'failed'
      let failure = 'provisioning did not leave a resumable child Session'
      let route: { agentProvider?: string; agentModel?: string } = {}
      try {
        /* v8 ignore start -- inspect of a leftover provisioning child, including a matching continuable log. */
        const loaded = await readPersistedSession(this.ctx.sessionPersistence, member.id, signal)
        const suffix = loaded.events.slice(loaded.inheritedEventCount)
        const descriptor = foldSubagentDescriptor(suffix)
        const acceptedInitialPrompt = messageAccepted(suffix, message => message.source.kind === 'user')
        if (loaded.header.parentSession === root.id
          && descriptor?.mode === 'continuable'
          && descriptor.provider === member.provider
          && acceptedInitialPrompt) {
          phase = 'active'
          route = {
            ...descriptor.agentProvider === undefined ? {} : { agentProvider: descriptor.agentProvider },
            ...descriptor.agentModel === undefined ? {} : { agentModel: descriptor.agentModel },
          }
        } else {
          failure = 'persisted child Session does not match the provisioned continuation'
        }
        /* v8 ignore stop */
      } catch (error: unknown) {
        failure = `child Session recovery failed: ${errorMessage(error)}`
      }
      signal.throwIfAborted()
      await this.journal.transact(root.id, async () => {
        signal.throwIfAborted()
        const current = this.journal.state(root).members.find(candidate => candidate.id === member.id)
        /* v8 ignore next -- another settler already left provisioning. */
        if (current?.phase !== 'provisioning') return
        const settled: TeamMemberSnapshot = {
          ...current,
          phase,
          /* v8 ignore next -- successful recovery omits the error field. */
          ...phase === 'failed' ? { error: failure } : route,
        }
        await this.journal.appendAndFlush(root.session, 'team/member', {
          teamId: TeamId(root.id),
          member: settled,
        })
      })
    }
  }

  /** Build one runtime member row after successful creation. */
  private memberView(member: TeamMemberSnapshot & { readonly phase: 'active' }): TeamMemberView {
    const live = this.ctx.agents.get(member.id)
    return {
      id: member.id,
      name: member.name,
      role: 'teammate',
      status: live?.status ?? 'inactive',
      description: member.description,
      provider: member.provider,
      context: member.context,
      ...routeFields(this.teammateRoute(member, live)),
      diagnostics: [],
    }
  }

  /** Validate a never-reused model-facing teammate name. */
  private memberName(value: string): string {
    if (!MEMBER_NAME.test(value) || value.length > 64 || value === 'lead' || value === 'subagent') {
      throw new TeamError(
        'teammate name must be lower-kebab-case, at most 64 characters, and not "lead" or "subagent"',
        'TEAM_INVALID_MEMBER_NAME',
      )
    }
    return value
  }

  /** Append one terminal provisioning edge unless recovery already settled it. */
  private async settleProvisioning(
    root: Agent,
    terminal: TeamMemberSnapshot,
  ): Promise<'active' | 'failed'> {
    return this.journal.transact(root.id, async () => {
      const current = this.journal.state(root).members.find(member => member.id === terminal.id)
      /* v8 ignore start -- recovery already settled or deleted the provisioning row. */
      if (current === undefined) {
        throw new TeamError(`provisioned teammate "${terminal.id}" disappeared`, 'TEAM_PROVISIONING_CONFLICT')
      }
      if (current.phase !== 'provisioning') return current.phase
      /* v8 ignore stop */
      await this.journal.appendAndFlush(root.session, 'team/member', {
        teamId: TeamId(root.id),
        member: terminal,
      })
      return terminal.phase === 'active' ? 'active' : 'failed'
    })
  }

  /** Whether a Session's own suffix identifies a provider-owned subagent child. */
  private subagentDescriptor(agent: Agent): boolean {
    return foldSubagentDescriptor(agent.session.events.slice(agent.session.header.seedLength ?? 0)) !== undefined
  }
}
