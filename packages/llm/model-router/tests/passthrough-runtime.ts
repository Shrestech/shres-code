/** Explicit metadata-only preparation fixture for replay projection tests. */
import type { LlmRuntime } from '@shres-code/shres-code-llm'

/**
 * Preserve the caller's config without adapter defaults; never dispatch a request.
 * @param resolveModelInfo - test-owned metadata lookup.
 * @returns the two operations consumed by replay and eligibility.
 */
export function passthroughRuntime(
  resolveModelInfo: LlmRuntime['resolveModelInfo'],
): Pick<LlmRuntime, 'resolveModelInfo' | 'prepareCall'> {
  return {
    resolveModelInfo,
    prepareCall: async config => ({
      config,
      adapterDefaults: {},
      retryPolicy: { mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
      stream() { throw new Error('replay fixture must not dispatch a request') },
    }),
  }
}
