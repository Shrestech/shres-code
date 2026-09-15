/** Agent Teams runtime façade over roster and mailbox. */

import { Context, Service } from '@shres-code/cordis'
import type { Agent } from '@shres-code/shres-code-agent'
import { SessionId } from '@shres-code/shres-code-session'
import { errorMessage } from './error.ts'
import { TeamJournal } from './journal.ts'
import { TeamRuntimeLifecycle } from './lifecycle.ts'
import { TeamMailbox } from './mailbox.ts'
import { TeamRoster } from './roster.ts'
import type { TeamMembership } from './roster.ts'
import { TeamError } from './error.ts'
import type {
  SendTeamMessageRequest,
  SendTeamMessageResult,
  SpawnTeammateRequest,
  SpawnTeammateResult,
  TeamMemberView,
  TeamRosterTemplateEntry,
} from './types.ts'

declare module '@shres-code/cordis' {
  interface Context {
    agentTeams: TeamService
  }
}

/** Agent Teams service backed by the exact live Lead Session log. */
export class TeamService extends Service {
  static inject = ['agents', 'sessions', 'sessionPersistence', 'sessionProjections', 'subagents']

  private readonly lifecycle: TeamRuntimeLifecycle
  private readonly journal: TeamJournal
  private readonly roster: TeamRoster
  private readonly mailbox: TeamMailbox
  private template: () => readonly TeamRosterTemplateEntry[] = () => []

  /**
   * @param ctx - host context with Agent, Session, persistence, and subagent services.
   * @param config - schema-defaulted deployment limits.
   */
  constructor(ctx: Context, config: {
    readonly maxMembers: number
    readonly maxTasks: number
    readonly maxPendingMessagesPerMember: number
    readonly maxMessageBytes: number
    readonly disposalTimeoutMs: number
  }) {
    super(ctx, 'agentTeams')
    this.lifecycle = new TeamRuntimeLifecycle(config.disposalTimeoutMs)
    this.journal = new TeamJournal(ctx)
    this.roster = new TeamRoster(ctx, this.journal, this.lifecycle, config.maxMembers)
    this.mailbox = new TeamMailbox(
      ctx,
      this.journal,
      this.roster,
      this.lifecycle,
      config.maxPendingMessagesPerMember,
      config.maxMessageBytes,
    )
    ctx.on('session/event', (session, event) => { this.mailbox.observeSessionEvent(session, event) })
    ctx.on('agent/session-start', ({ agent }) => { this.scheduleRecovery(agent) })
    ctx.effect(() => () => {
      void this.disposeRuntime()
    }, 'agentTeams.runtimeLifecycle()')
    for (const agent of ctx.agents.list()) this.scheduleRecovery(agent)
  }

  /**
   * Resolve one exact live Agent's Team role.
   * @param agent - exact live Agent used as the authority credential.
   * @returns its root, Team identity, role, and model-facing name.
   */
  membership(agent: Agent): TeamMembership {
    return this.roster.membership(agent)
  }

  /**
   * Resolve a caller without throwing.
   * @param agent - candidate exact live Agent.
   * @returns Team membership, or undefined for non-Team subagents.
   */
  tryMembership(agent: Agent): TeamMembership | undefined {
    return this.roster.tryMembership(agent)
  }

  /**
   * List the runtime-enriched roster visible to one Team member.
   * @param agent - exact live Team member.
   * @returns Lead and teammate rows in creation order.
   */
  listMembers(agent: Agent): TeamMemberView[] {
    const listed = this.roster.list(this.roster.membership(agent))
    const seen = new Set(listed.map(row => row.name))
    for (const entry of this.template()) {
      if (seen.has(entry.name)) continue
      listed.push({
        id: SessionId(`unprovisioned:${entry.name}`),
        name: entry.name,
        role: 'teammate',
        status: 'inactive',
        description: entry.description,
        provider: entry.provider,
        ...entry.model === undefined ? {} : { model: entry.model },
        diagnostics: [],
      })
    }
    return listed
  }

  /**
   * Create one named, continuable direct child of the Team Lead.
   * @param caller - exact live Lead Agent.
   * @param request - immutable name, description, prompt, context mode, provider, and cancellation.
   * @returns the active roster row.
   */
  async spawnTeammate(caller: Agent, request: SpawnTeammateRequest): Promise<SpawnTeammateResult> {
    return await this.roster.spawn(caller, request)
  }

  /**
   * Queue one durable peer message, then attempt immediate steer delivery.
   * @param caller - exact live sending Team member.
   * @param request - target name, content, and pre-queue cancellation.
   * @returns durable message identity and immediate-delivery observation.
   */
  async sendMessage(caller: Agent, request: SendTeamMessageRequest): Promise<SendTeamMessageResult> {
    const membership = this.roster.membership(caller)
    if (membership.role === 'lead') await this.ensureTemplateMember(caller, request.target)
    return await this.mailbox.send(caller, request)
  }

  /**
   * Replace the human-configured roster used for lazy provisioning.
   * @param source - bound seats and YAML extras for this process.
   */
  setRosterTemplate(source: () => readonly TeamRosterTemplateEntry[]): void {
    this.template = source
  }

  /**
   * Provision a template teammate when the Lead first addresses that name.
   * @param lead - exact live Team Lead.
   * @param rawName - teammate name from team_send or a named seat tool.
   */
  async ensureTemplateMember(lead: Agent, rawName: string): Promise<void> {
    const name = rawName.trim()
    if (name === 'lead' || name === String(lead.id)) return
    const state = this.journal.state(lead)
    const existing = state.members.find(member => member.name === name)
    if (existing?.phase === 'active') return
    if (existing?.phase === 'failed') {
      throw new TeamError(`teammate "${name}" previously failed provisioning`, 'TEAM_MEMBER_NOT_FOUND')
    }
    if (existing?.phase === 'provisioning') return
    const entry = this.template().find(candidate => candidate.name === name)
    if (entry === undefined) return
    await this.roster.spawn(lead, {
      name: entry.name,
      description: entry.description,
      prompt: [{ type: 'text', text: entry.description === entry.name ? `You are ${entry.name}.` : `You are ${entry.name}. ${entry.description}` }],
      context: entry.context ?? 'fresh',
      provider: 'spawn',
      signal: this.lifecycle.signal,
      ...entry.persona !== undefined ? { persona: entry.persona } : {},
      ...entry.model !== undefined ? { agentOptions: { provider: entry.provider, model: entry.model } } : {},
    })
  }

  /** Queue one contained recovery pass after publication has unwound. */
  private scheduleRecovery(agent: Agent): void {
    queueMicrotask(() => {
      /* v8 ignore next -- session-start after the runtime admission cutoff. */
      if (this.lifecycle.disposed) return
      void this.recoverFor(agent).catch((error: unknown) => {
        /* v8 ignore start -- contained recovery; dispose can close while the pass is in flight. */
        if (this.lifecycle.disposed) return
        this.ctx.logger.warn(`Agent Teams recovery for "${agent.id}" failed: ${errorMessage(error)}`)
        /* v8 ignore stop */
      })
    })
  }

  /** Reconcile roster provisioning before retrying that member's pending mailbox. */
  private async recoverFor(agent: Agent): Promise<void> {
    await this.roster.recoverFor(agent, this.lifecycle.signal)
    await this.mailbox.recoverFor(agent, this.lifecycle.signal)
  }

  /** Stop Team-owned live branches before service disposal completes. */
  private async disposeRuntime(): Promise<void> {
    this.lifecycle.close()
    const failures: unknown[] = []
    await this.lifecycle.settle([
      ...this.roster.pendingCreations(),
      ...this.mailbox.pendingDispatches(),
    ], failures)
    /* v8 ignore next 2 -- unexpected settlement failures are logged; cancellation is filtered out. */
    if (failures.length > 0) {
      this.ctx.logger.warn(`Agent Teams disposal observed ${failures.length} unexpected failure(s)`)
    }
  }
}
