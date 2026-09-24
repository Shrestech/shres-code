/** Agent Teams runtime façade over roster and mailbox. */

import { Context, Service } from '@shres-code/cordis'
import type { Agent } from '@shres-code/shres-code-agent'
import { randomUUID } from 'node:crypto'
import type { ContentBlock } from '@shres-code/shres-code-llm'
import { SessionId } from '@shres-code/shres-code-session'
import { TeamId, TeamMessageId } from './brand.ts'
import { errorMessage } from './error.ts'
import { TeamJournal } from './journal.ts'
import { TeamRuntimeLifecycle } from './lifecycle.ts'
import { TeamMailbox } from './mailbox.ts'
import { TeamRoster, teammateSeatGuard } from './roster.ts'
import type { TeamMembership } from './roster.ts'
import { TeamError } from './error.ts'
import { ENVIRONMENT_ORDER, ENVIRONMENT_SECTION } from '@shres-code/shres-code-subagent'
import type {} from '@shres-code/shres-code-system-prompt'
import { TEAM_POLICY_ORDER, TEAM_POLICY_SECTION, teammatePolicy } from './policy.ts'
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

/**
 * Join text blocks from one assignment used as the child's first user message.
 * @param assignment - mailbox content from team_send or a named seat tool.
 * @returns joined text, or undefined when the assignment has no text.
 */
function assignmentText(assignment: readonly ContentBlock[] | undefined): string | undefined {
  if (assignment === undefined || assignment.length === 0) return undefined
  const parts: string[] = []
  for (const block of assignment) {
    switch (block.type) {
      case 'text':
        if (block.text.trim().length > 0) parts.push(block.text)
        break
      default:
        break
    }
  }
  if (parts.length === 0) return undefined
  return parts.join('\n\n')
}

/** Subagent spawn provider that starts every template teammate. */
const TEMPLATE_SPAWN_PROVIDER = 'spawn'

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
    ctx.on('agent/session-start', ({ agent }) => {
      this.installTeammateComposition(agent)
      this.scheduleRecovery(agent)
    })
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
        status: 'unstarted',
        description: entry.description,
        provider: TEMPLATE_SPAWN_PROVIDER,
        ...entry.model === undefined ? {} : { agentProvider: entry.provider, model: entry.model },
        diagnostics: [],
      })
    }
    return listed
  }

  /**
   * Create one named, continuable direct child of the Team Lead.
   * @param caller - exact live Lead Agent.
   * @param request - immutable name, description, prompt, context mode, provider, optional persona and cwd, and cancellation.
   * @returns the active roster row.
   */
  async spawnTeammate(caller: Agent, request: SpawnTeammateRequest): Promise<SpawnTeammateResult> {
    return await this.roster.spawn(caller, request)
  }

  /**
   * Queue one durable peer message, then attempt immediate steer delivery.
   * The Lead's first address of a template name starts that teammate with
   * this content as the child's initial user message. A Lead-sent `persona`
   * shadows `deployment:persona`. A Lead-sent `cwd` becomes the child's
   * workspace. The assignment is recorded on the Lead log as queued then
   * delivered mail; this call does not steer a second copy.
   * @param caller - exact live sending Team member.
   * @param request - target name, content, optional first-provision persona and cwd, and pre-queue cancellation.
   * @returns durable message identity and immediate-delivery observation.
   */
  async sendMessage(caller: Agent, request: SendTeamMessageRequest): Promise<SendTeamMessageResult> {
    const provisioned = await this.ensureTemplateMember(
      caller,
      request.target,
      request.content,
      request.persona,
      request.cwd,
      request.signal,
    )
    if (provisioned !== undefined) return provisioned
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
   * Reads the Lead journal from the caller's membership root. Concurrent
   * first-use of the same name waits for the one in-flight creation. A
   * teammate may wait for an in-flight row or mail an active name; only the
   * Lead starts a missing template member.
   * @param caller - exact live Team member addressing the name.
   * @param rawName - teammate name from team_send or a named seat tool.
   * @param assignment - first user message when this call starts the teammate. Omitted or empty text keeps the role gloss.
   * @param persona - Lead-sent role. Non-empty text shadows the child's `deployment:persona`.
   * @param cwd - Lead-sent workspace. Non-empty text becomes the child's session cwd.
   * @param signal - caller cancellation; omitted uses the Team lifecycle signal.
   * @returns the recorded first-assignment mail when this call started the teammate.
   */
  async ensureTemplateMember(
    caller: Agent,
    rawName: string,
    assignment?: readonly ContentBlock[],
    persona?: string,
    cwd?: string,
    signal?: AbortSignal,
  ): Promise<SendTeamMessageResult | undefined> {
    const membership = this.roster.membership(caller)
    const root = membership.root
    const name = rawName.trim()
    if (name === 'lead' || name === String(root.id)) return undefined
    await this.roster.waitForCreation(root, name)
    const state = this.journal.state(root)
    const existing = state.members.find(member => member.name === name)
    const assignedCwd = cwd !== undefined && cwd.trim().length > 0 ? cwd : undefined
    if (existing?.phase === 'active') {
      if (assignedCwd !== undefined) {
        throw new TeamError(
          `cwd can be set only when first provisioning teammate "${name}"`,
          'TEAM_INVALID_ARGUMENT',
        )
      }
      return undefined
    }
    if (existing?.phase === 'failed') {
      throw new TeamError(`teammate "${name}" previously failed provisioning`, 'TEAM_MEMBER_NOT_FOUND')
    }
    if (existing?.phase === 'provisioning') {
      throw new TeamError(`active teammate "${name}" not found`, 'TEAM_MEMBER_NOT_FOUND')
    }
    if (membership.role !== 'lead') {
      throw new TeamError(`only the Team Lead can provision teammate "${name}"`, 'TEAM_LEAD_REQUIRED')
    }
    const entry = this.template().find(candidate => candidate.name === name)
    if (entry === undefined) return undefined
    const assigned = assignmentText(assignment)
    const prompt = assigned !== undefined && assignment !== undefined
      ? structuredClone(assignment)
      : [{
        type: 'text' as const,
        text: entry.description === entry.name ? `You are ${entry.name}.` : `You are ${entry.name}. ${entry.description}`,
      }]
    const assignedPersona = persona !== undefined && persona.trim().length > 0 ? persona : undefined
    const childPersona = assignedPersona ?? entry.persona
    const messageId = TeamMessageId(`team-message-${randomUUID()}`)
    const message = {
      id: messageId,
      senderId: caller.id,
      senderName: membership.name,
      targetId: root.id,
      content: structuredClone(prompt),
    }
    this.mailbox.assertFits(message)
    const started = await this.roster.spawn(root, {
      name: entry.name,
      description: entry.description,
      prompt,
      context: entry.context ?? 'fresh',
      provider: TEMPLATE_SPAWN_PROVIDER,
      signal: AbortSignal.any([signal ?? this.lifecycle.signal, this.lifecycle.signal]),
      source: {
        kind: 'team-message',
        form: 'relay',
        teamId: TeamId(root.id),
        messageId,
        senderSessionId: caller.id,
        senderName: membership.name,
      },
      ...childPersona !== undefined ? { persona: childPersona } : {},
      ...assignedCwd !== undefined ? { cwd: assignedCwd } : {},
      ...entry.model !== undefined ? { agentOptions: { provider: entry.provider, model: entry.model } } : {},
    })
    await this.mailbox.recordSpawnedAssignment(caller, started.member.id, prompt, messageId)
    return { messageId, status: 'accepted' }
  }

  /**
   * Install teammate-only prompt sections and seat-tool denial. Ordinary roots
   * and generic subagents are left unchanged.
   * @param agent - newly started exact live Agent.
   */
  private installTeammateComposition(agent: Agent): void {
    const membership = this.roster.tryMembership(agent)
    if (membership?.role !== 'teammate') return
    /* v8 ignore next -- product trees mount systemPrompt; a registry-less host has no section to install. */
    if (agent.ctx.get('systemPrompt') !== undefined) {
      agent.ctx.systemPrompt.section({
        name: TEAM_POLICY_SECTION,
        order: TEAM_POLICY_ORDER,
        text: teammatePolicy(membership.name),
      })
      const cwd = agent.session.header.cwd
      if (cwd !== undefined && cwd.length > 0) {
        agent.ctx.systemPrompt.section({
          name: ENVIRONMENT_SECTION,
          order: ENVIRONMENT_ORDER,
          text: 'Your working directory is {{cwd}}.',
        })
      }
    }
    /* v8 ignore next -- product trees mount tools; a registry-less host has no seat tools to deny. */
    if (agent.ctx.get('tools') !== undefined) agent.ctx.tools.guard(teammateSeatGuard)
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
