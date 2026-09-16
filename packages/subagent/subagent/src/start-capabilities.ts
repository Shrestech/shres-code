/**
 * Shared start-time capability check: refuse a requested option the provider
 * does not advertise, so neither the service dispatch path nor a direct
 * `provider.start()` can accept-then-ignore it.
 *
 * @module @shres-code/shres-code-subagent/start-capabilities
 */

import { SubagentError } from './error.ts'
import type { SubagentCapabilities, SubagentStartRequest } from './types.ts'

type StartOptionRequest = Pick<SubagentStartRequest, 'outputSchema' | 'maxDepth' | 'toolFilter' | 'persona' | 'cwd'>

const START_OPTIONS = [
  {
    option: 'outputSchema',
    cap: 'outputSchema',
    present: (request: StartOptionRequest) => request.outputSchema !== undefined,
  },
  {
    option: 'maxDepth',
    cap: 'depthLimit',
    present: (request: StartOptionRequest) => request.maxDepth !== undefined,
  },
  {
    option: 'toolFilter',
    cap: 'toolFilter',
    present: (request: StartOptionRequest) => request.toolFilter !== undefined,
  },
  {
    option: 'persona',
    cap: 'persona',
    present: (request: StartOptionRequest) => request.persona !== undefined,
  },
  {
    option: 'cwd',
    cap: 'cwd',
    present: (request: StartOptionRequest) => request.cwd !== undefined,
  },
] as const satisfies ReadonlyArray<{
  option: string
  cap: keyof SubagentCapabilities
  present: (request: StartOptionRequest) => boolean
}>

/**
 * Reject the first requested start-time option that `capabilities` does not
 * advertise.
 * @param providerName - the registry name used in the diagnostic.
 * @param request - the caller request, or the subset of start-time options it set.
 * @param capabilities - the provider's advertised start-time features.
 * @throws {SubagentError} `UNSUPPORTED_CAPABILITY` naming the option.
 */
export function assertStartCapabilities(
  providerName: string,
  request: Pick<SubagentStartRequest, 'outputSchema' | 'maxDepth' | 'toolFilter' | 'persona' | 'cwd'>,
  capabilities: SubagentCapabilities,
): void {
  for (const { option, cap, present } of START_OPTIONS) {
    if (present(request) && !capabilities[cap]) {
      throw new SubagentError(
        `subagent provider "${providerName}" does not support ${option}`,
        'UNSUPPORTED_CAPABILITY',
      )
    }
  }
}
