import { describe, expect, it } from 'vitest'
import { LedgerError, newLedgerEntryId, resolveRecord } from '@shres-code/shres-code-ledger'
import type { LedgerRequest } from '@shres-code/shres-code-ledger'
import type { TrackerRunId } from '@shres-code/shres-code-tracker'

function runId(id: string): TrackerRunId {
  return id as TrackerRunId
}

function validRequest(overrides: Partial<LedgerRequest> = {}): LedgerRequest {
  return {
    hypothesis: 'h',
    decision: 'accepted',
    evidence: { runIds: [runId('run-1')] },
    rationale: 'r',
    ...overrides,
  }
}

describe('newLedgerEntryId', () => {
  it('returns a non-empty branded entry id', () => {
    expect(newLedgerEntryId().length).toBeGreaterThan(0)
  })
})

describe('resolveRecord', () => {
  it('defaults artifactUris to an empty list', () => {
    const spec = resolveRecord(validRequest())
    expect(spec.evidence.artifactUris).toEqual([])
  })

  it('carries supplied evidence through', () => {
    const spec = resolveRecord(validRequest({
      evidence: { runIds: [runId('run-1')], gitSha: 'abc123', artifactUris: ['modelstore://a'] },
    }))
    expect(spec.evidence.runIds).toEqual([runId('run-1')])
    expect(spec.evidence.gitSha).toBe('abc123')
    expect(spec.evidence.artifactUris).toEqual(['modelstore://a'])
  })

  it('keeps string values exactly as supplied', () => {
    const spec = resolveRecord(validRequest())
    expect(spec.hypothesis).toBe('h')
    expect(spec.rationale).toBe('r')
    expect(spec.decision).toBe('accepted')
  })

  it('accepts a deferred decision with no run ids', () => {
    const spec = resolveRecord(validRequest({ decision: 'deferred', evidence: { runIds: [] } }))
    expect(spec.decision).toBe('deferred')
    expect(spec.evidence.runIds).toEqual([])
  })

  it.each([
    ['hypothesis', { hypothesis: '' }],
    ['hypothesis', { hypothesis: '   ' }],
    ['hypothesis', { hypothesis: undefined }],
    ['rationale', { rationale: '' }],
    ['rationale', { rationale: '   ' }],
    ['rationale', { rationale: undefined }],
  ])('rejects a blank %s with required-field', (field, overrides) => {
    expect(() => resolveRecord(validRequest({ ...overrides } as LedgerRequest)))
      .toThrow(new RegExp(`requires a non-empty ${field}`))
  })

  it('rejects an accepted decision with no run ids as missing-run', () => {
    expect(() => resolveRecord(validRequest({ evidence: { runIds: [] } })))
      .toThrow(new RegExp('requires at least one run id'))
  })

  it('rejects a rejected decision with no run ids as missing-run', () => {
    expect(() => resolveRecord(validRequest({ decision: 'rejected', evidence: { runIds: [] } })))
      .toThrow(new RegExp('requires at least one run id'))
  })

  it('rejects a deferred decision that cites run ids as deferred-cites-runs', () => {
    expect(() => resolveRecord(validRequest({ decision: 'deferred', evidence: { runIds: [runId('run-1')] } })))
      .toThrow(new RegExp('must not cite run ids'))
  })

})

describe('LedgerError', () => {
  it('carries its machine code', () => {
    const error = new LedgerError('boom', 'required-field')
    expect(error.code).toBe('required-field')
    expect(error.name).toBe('LedgerError')
  })
})
