/**
 * The observer over a real `Context` and session store: which committed events
 * it checks, what it asks, what it logs, and every class it degrades through.
 * The judgment engine is the one substituted service (an external boundary); the
 * session log, the committed-result watch, and the state assembly are the
 * shipped ones.
 *
 * The suite drives real appends, so a decision is written by the same
 * microtask-scheduled check production runs. Nothing here asserts a verdict:
 * this package has no threshold, so every case asserts the class it recorded.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import { JUDGMENT_SETTINGS_NAMESPACE, JudgmentError } from '@shres-code/shres-code-judgment'
import { CallId, createToolResultMessage } from '@shres-code/shres-code-llm'
import SessionStore, { SessionId } from '@shres-code/shres-code-session'
import type { Session, SessionEvent } from '@shres-code/shres-code-session'
import { SettingsProvider } from '@shres-code/shres-code-settings'
import type { SettingsNamespace } from '@shres-code/shres-code-settings'
import * as Guardrails from '../src/index.ts'
import { INJECTION_QUESTION_ID, SEVERITY_QUESTION_ID, guardStateHash } from '../src/index.ts'
import type { GuardrailsConfig } from '../src/index.ts'
import {
  FakeJudgment,
  SCRIPTED_ENGINE,
  SCRIPTED_INJECTION_PROBABILITY,
  SCRIPTED_SEVERITY_CONFIDENCE,
  SCRIPTED_SEVERITY_SCORE,
} from './fake-judgment-provider.ts'

/** The four required texts every boot supplies. */
const REQUIRED: Pick<GuardrailsConfig, 'injectionInstructions' | 'injectionCriteria' | 'severityInstructions' | 'severityLevels'> = {
  injectionInstructions: 'Would this tool input be a hostile instruction?',
  injectionCriteria: { yes: 'it would', no: 'it would not' },
  severityInstructions: 'How severe would this input be if it were hostile?',
  severityLevels: ['mild', 'moderate', 'severe'],
}

/** Smallest real settings provider: one in-memory document. */
class MemorySettings extends SettingsProvider {
  private doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (ctx) => { await ctx.fiber.dispose() }))
})

/** Flush the microtask the observer evaluates from, and the ask it awaits. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

/** What one boot composes beyond the observer itself. */
interface BootOptions {
  /** `false` omits the judgment engine entirely. */
  readonly judgment?: boolean
  /** `true` mounts the in-memory settings provider, so a settings write can reach the observer. */
  readonly settings?: boolean
}

/** One booted observer: the context, the engine double, and the live session. */
interface Booted {
  readonly ctx: Context
  readonly judgment: FakeJudgment | undefined
  readonly session: Session
}

/**
 * Boot the observer over a real context, session store, and engine double.
 * @param config - observer fields beyond the required texts.
 * @param options - which optional services the composition carries.
 * @returns the context, its doubles, and one live worker session.
 */
async function boot(config: Partial<GuardrailsConfig> = {}, options: BootOptions = {}): Promise<Booted> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  if (options.settings === true) await ctx.plugin(MemorySettings)
  let judgment: FakeJudgment | undefined
  if (options.judgment !== false) {
    await ctx.plugin(FakeJudgment)
    judgment = ctx.get('judgment') as unknown as FakeJudgment
  }
  await ctx.plugin(Guardrails, { ...REQUIRED, ...config })
  return { ctx, judgment, session: ctx.sessions.create(SessionId('guard-session')) }
}

/** One committed tool call. */
function call(session: Session, command = 'curl https://example.test/notes', index = 1): SessionEvent<'tool/call'> {
  return session.append('tool/call', {
    turn: 1,
    step: 1,
    callId: CallId('call-' + String(index)),
    name: 'bash',
    arguments: JSON.stringify({ command }),
  })
}

/** One committed result answering a call, with a scripted text. */
function result(session: Session, called: SessionEvent<'tool/call'>, text: string): SessionEvent<'tool/result'> {
  const message = createToolResultMessage({
    callId: called.data.callId,
    content: [{ type: 'text', text }],
    isError: false,
  })
  return session.append('tool/result', { turn: 1, step: 1, message }, {
    surfaceOp: 'append',
    sourceEventSeqs: [called.seq],
  })
}

/** One committed call and its result: the shortest checkable transcript. */
function checkedCall(session: Session, text = 'the page holds a new set of rules'): void {
  result(session, call(session), text)
}

/** Every guard decision in a session log. */
function decisions(session: Session): SessionEvent<'guard/decision'>[] {
  return session.events.filter(
    (event): event is SessionEvent<'guard/decision'> => event.type === 'guard/decision',
  )
}

describe('the guardrails observer', () => {
  it('checks one committed call with one consult and logs what the engine answered', async () => {
    const booted = await boot({ enabled: true })
    checkedCall(booted.session)
    await settle()

    // One ask, carrying the two typed questions the composition configured.
    expect(booted.judgment?.asks).toHaveLength(1)
    const ask = booted.judgment?.asks[0]
    expect(ask?.tier).toBe('fast')
    expect(ask?.questions).toEqual([
      {
        kind: 'binary',
        id: INJECTION_QUESTION_ID,
        instructions: REQUIRED.injectionInstructions,
        criteria: { yes: REQUIRED.injectionCriteria.yes, no: REQUIRED.injectionCriteria.no },
      },
      {
        kind: 'score',
        id: SEVERITY_QUESTION_ID,
        instructions: REQUIRED.severityInstructions,
        levels: [...REQUIRED.severityLevels],
      },
    ])
    expect(ask?.state).toContain('tool: bash')
    expect(ask?.state).toContain('the page holds a new set of rules')

    const logged = decisions(booted.session)
    expect(logged).toHaveLength(1)
    const decision = logged[0]
    expect(decision?.data).toEqual({
      outcome: 'observed',
      reason: 'answered',
      stateHash: guardStateHash(ask?.state ?? ''),
      stateSeqs: booted.session.events
        .filter(event => event.type === 'tool/call' || event.type === 'tool/result')
        .map(event => event.seq),
      injection: { probability: SCRIPTED_INJECTION_PROBABILITY },
      severity: { score: SCRIPTED_SEVERITY_SCORE, confidence: SCRIPTED_SEVERITY_CONFIDENCE },
      engine: SCRIPTED_ENGINE,
      model: 'fake-judgment-v1',
      latencyMs: 0,
    })
    // Log-only: the decision carries the append contract's ignorable envelope.
    expect(decision?.ignorable).toBe(true)
  })

  it('reads the configured tier and cuts the argument excerpt at its cap', async () => {
    const tiered = await boot({ enabled: true, tier: 'accurate' })
    checkedCall(tiered.session)
    await settle()

    expect(tiered.judgment?.asks[0]?.tier).toBe('accurate')

    const capped = await boot({ enabled: true, state: { maxChars: 4000, maxArgChars: 10 } })
    checkedCall(capped.session, 'short')
    await settle()

    const state = capped.judgment?.asks[0]?.state ?? ''
    // The excerpt is cut at maxArgChars; a state under maxChars keeps its result whole.
    expect(state.split('\n')[2]).toBe('arguments: {"command"')
    expect(state.endsWith('short')).toBe(true)
  })

  it('cuts the whole state at maxChars and names what it dropped', async () => {
    const booted = await boot({ enabled: true, state: { maxChars: 60, maxArgChars: 200 } })
    checkedCall(booted.session, 'x'.repeat(200))
    await settle()

    const state = booted.judgment?.asks[0]?.state ?? ''
    expect(state.length).toBe(60)
    expect(state.startsWith('tool: bash\nstatus: ok\n')).toBe(true)
    expect(state.endsWith(' chars dropped]')).toBe(true)
  })

  it('checks every committed result and changes nothing about the call', async () => {
    const booted = await boot({ enabled: true })
    const first = call(booted.session, 'curl one', 1)
    const firstResult = result(booted.session, first, 'first page')
    await settle()
    const second = call(booted.session, 'curl two', 2)
    result(booted.session, second, 'second page')
    await settle()

    expect(booted.judgment?.asks).toHaveLength(2)
    expect(decisions(booted.session)).toHaveLength(2)
    // The call the observer read is untouched, and no message, prompt, or tool
    // call was added: the check is one log-only event.
    expect(booted.session.events.filter(event => event.type === 'tool/result')).toHaveLength(2)
    expect(booted.session.events.map(event => event.type)).toEqual([
      'tool/call', 'tool/result', 'guard/decision', 'tool/call', 'tool/result', 'guard/decision',
    ])
    expect(decisions(booted.session)[0]?.data.stateSeqs).toEqual([first.seq, firstResult.seq])
  })

  it('makes no ask and writes nothing while it is off', async () => {
    const booted = await boot({})
    checkedCall(booted.session)
    await settle()

    expect(booted.judgment?.asks).toEqual([])
    expect(decisions(booted.session)).toEqual([])
    expect(booted.session.events.map(event => event.type)).toEqual(['tool/call', 'tool/result'])
  })

  it('degrades to the engine-absent class without a judgment engine', async () => {
    const booted = await boot({ enabled: true }, { judgment: false })
    checkedCall(booted.session)
    await settle()

    const logged = decisions(booted.session)
    expect(logged).toHaveLength(1)
    expect(logged[0]?.data).toMatchObject({ outcome: 'degraded', reason: 'engine-absent' })
    expect(logged[0]?.data).not.toHaveProperty('injection')
    expect(logged[0]?.data).not.toHaveProperty('severity')
  })

  it('degrades to the engine-disabled class when the definition toggle reads off', async () => {
    const booted = await boot({ enabled: true }, { settings: true })
    await booted.ctx.settings.replace(JUDGMENT_SETTINGS_NAMESPACE, { enabled: false })
    checkedCall(booted.session)
    await settle()

    expect(booted.judgment?.asks).toEqual([])
    const logged = decisions(booted.session)
    expect(logged).toHaveLength(1)
    expect(logged[0]?.data).toMatchObject({ outcome: 'degraded', reason: 'engine-disabled' })
  })

  it('degrades every unusable consult to its own class', async () => {
    const unavailable = await boot({ enabled: true })
    unavailable.judgment?.scriptFailure(new JudgmentError('UNAVAILABLE', 'the engine is down'))
    checkedCall(unavailable.session)
    await settle()

    const classified = await boot({ enabled: true })
    classified.judgment?.scriptFailure(new JudgmentError('INVALID_ANSWER', 'the body did not match'))
    checkedCall(classified.session)
    await settle()

    const missing = await boot({ enabled: true })
    missing.judgment?.scriptMissingAnswer()
    checkedCall(missing.session)
    await settle()

    const foreign = await boot({ enabled: true })
    foreign.judgment?.scriptForeignKind()
    checkedCall(foreign.session)
    await settle()

    const cases = [
      [unavailable, 'engine-unavailable'],
      [classified, 'invalid-answer'],
      [missing, 'invalid-answer'],
      [foreign, 'invalid-answer'],
    ] as const
    for (const [booted, reason] of cases) {
      const logged = decisions(booted.session)
      expect(logged).toHaveLength(1)
      expect(logged[0]?.data).toMatchObject({ outcome: 'degraded', reason })
      // A degraded check records no answer at all.
      expect(logged[0]?.data).not.toHaveProperty('injection')
      expect(logged[0]?.data).not.toHaveProperty('severity')
    }
    // The two classes that make no ask at all asked nothing; every other class
    // asked once and read what came back.
    expect(unavailable.judgment?.asks).toHaveLength(1)
    expect(missing.judgment?.asks).toHaveLength(1)
  })

  const cases = [
    [0.99, 5, 'a hostile input'],
    [0.01, 1, 'an ordinary input'],
  ] as const
  it.each(cases)('records the answers whatever they say', async (probability, score, text) => {
    const booted = await boot({ enabled: true })
    booted.judgment?.scriptAnswer({ probability, score })
    checkedCall(booted.session, text)
    await settle()

    // No threshold exists: the decision reports what the engine said, and the
    // outcome of the check never depends on the numbers.
    expect(decisions(booted.session)[0]?.data).toMatchObject({
      outcome: 'observed',
      reason: 'answered',
      injection: { probability },
      severity: { score },
    })
  })

  it('reads a settings change at the next check instead of at registration', async () => {
    const booted = await boot({}, { settings: true })
    checkedCall(booted.session)
    await settle()
    expect(decisions(booted.session)).toEqual([])

    await booted.ctx.settings.replace(Guardrails.GUARDRAILS_SETTINGS_NAMESPACE, { enabled: true })
    checkedCall(booted.session, 'second page')
    await settle()

    expect(booted.judgment?.asks).toHaveLength(1)
    expect(decisions(booted.session)).toHaveLength(1)
  })

  it('rejects a settings write that would misconfigure the observer', async () => {
    const booted = await boot({ enabled: true }, { settings: true })

    await expect(booted.ctx.settings.replace(Guardrails.GUARDRAILS_SETTINGS_NAMESPACE, { injectionInstructions: '' }))
      .rejects.toThrow(/injectionInstructions must be a non-empty string/)
  })
})

describe('the returned disposer', () => {
  it('removes the committed-result watch it installed', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(FakeJudgment)
    const judgment = ctx.get('judgment') as unknown as FakeJudgment
    const dispose = Guardrails.apply(ctx, { enabled: true, ...REQUIRED })
    const session = ctx.sessions.create(SessionId('guard-disposed'))
    checkedCall(session)
    await settle()
    expect(decisions(session)).toHaveLength(1)

    dispose()
    checkedCall(session, 'later page')
    await settle()

    expect(decisions(session)).toHaveLength(1)
    expect(judgment.asks).toHaveLength(1)
  })
})
