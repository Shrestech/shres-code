import { describe, expect, it } from 'vitest'
import type { SubagentResult } from '@shres-code/shres-code-subagent'
import {
  buildConsultPrompt,
  CONSULT_REQUIRES_CARD,
  CONSULT_UNAVAILABLE,
  consultRefusal,
  settleConsult,
  stopReasonError,
  withPartialText,
} from '../src/consult.ts'
import type { JspaceAdvisorDigest } from '../src/types.ts'

const DIGEST: JspaceAdvisorDigest = {
  card: 'Goal: ship',
  recentTools: [],
  userIntent: 'hi',
  steps: 1,
  seq: 0,
  maxTools: 12,
  maxChars: 4000,
}

function result(stopReason: SubagentResult['stopReason'], structured?: unknown, output: unknown[] = []): SubagentResult {
  return { stopReason, output: output as SubagentResult['output'], ...structured === undefined ? {} : { structured } }
}

describe('consultRefusal', () => {
  it('refuses when the seat is inactive or the advisor is unbound', () => {
    expect(consultRefusal(false, true, true)).toBe(CONSULT_UNAVAILABLE)
    expect(consultRefusal(true, true, false)).toBe(CONSULT_UNAVAILABLE)
  })

  it('refuses when no card is open', () => {
    expect(consultRefusal(true, false, true)).toBe(CONSULT_REQUIRES_CARD)
  })

  it('allows when armed, engaged, and a card is open', () => {
    expect(consultRefusal(true, true, true)).toBeUndefined()
  })
})

describe('stopReasonError', () => {
  it('returns undefined on completion', () => {
    expect(stopReasonError(result('completed'))).toBeUndefined()
  })

  it('maps non-completed reasons to headlines', () => {
    expect(stopReasonError(result('aborted'))).toMatch(/cancelled/)
    expect(stopReasonError(result('error'))).toMatch(/failed/)
    expect(stopReasonError(result('max-tokens'))).toMatch(/token limit/)
    expect(stopReasonError(result('refusal'))).toMatch(/declined/)
  })

  it('fails unknown terminal reasons', () => {
    expect(stopReasonError(result('mystery' as SubagentResult['stopReason']))).toMatch(/abnormally/)
  })
})

describe('withPartialText', () => {
  it('returns the headline when no text output exists', () => {
    expect(withPartialText('boom', [])).toBe('boom')
  })

  it('appends partial text when present', () => {
    const output = [{ type: 'text', text: 'partial answer' }]
    expect(withPartialText('boom', output as SubagentResult['output'])).toContain('partial answer')
  })
})

describe('settleConsult', () => {
  it('returns the structured reply on completion', () => {
    const reply = settleConsult(result('completed', { advice: 'you drifted', recommendation: 're-read the goal' }))
    expect(reply.advice).toBe('you drifted')
    expect(reply.recommendation).toBe('re-read the goal')
  })

  it('throws on a non-completed stop reason with partial text', () => {
    const output = [{ type: 'text', text: 'partial' }]
    expect(() => settleConsult(result('max-tokens', undefined, output))).toThrow(/token limit/)
  })

  it('throws when no structured advice is present', () => {
    expect(() => settleConsult(result('completed'))).toThrow(/no structured advice/)
  })
})

describe('buildConsultPrompt', () => {
  it('embeds the digest and question', () => {
    const prompt = buildConsultPrompt(DIGEST, 'am I drifting?')
    expect(prompt).toContain('Goal: ship')
    expect(prompt).toContain('am I drifting?')
  })
})
