/** Host BFF entry and Loader shell for the Remote contribution assembly. */

import type { TypertForwardableEvent } from '@shres-code/shres-code-typert-protocol'
import { API_REMOTE_FORWARDED_EVENTS } from './remote-events.ts'

// The remote-control event vocabulary (tunnel-state) lives in the package's
// client-safe types face. Host typecheck runs before Typert writes the
// `./remote` artifact, so this Host entry must not import it.
import type {} from '@shres-code/shres-code-host-remote-control/types'
import type {} from '@shres-code/shres-code-commands/types'
import type {} from '@shres-code/shres-code-cordis-host-runner/types'
import type {} from '@shres-code/shres-code-credentials/types'
import type {} from '@shres-code/shres-code-llm/types'
import type {} from '@shres-code/shres-code-agent-presets/types'
import type {} from '@shres-code/shres-code-settings/types'

export {
  ApiRemoteSessionNotFound,
  ApiRemoteSubagentSessionOwnership,
  apiRemoteSubagentOwnershipError,
  createApiRemoteAgentResolver,
  hasApiRemoteSubagentOwner,
  inspectApiRemoteSession,
} from './agent-lookup.ts'
export type {
  ApiRemoteAgentOptions,
  ApiRemoteAgentResult,
  ApiRemoteLookupError,
} from './agent-lookup.ts'
export { API_REMOTE_FORWARDED_EVENTS } from './remote-events.ts'
export type { ApiRemoteForwardedEvent } from './types.ts'

// Shape gate over the allowlist, kept in the Host face because the Host's event
// vocabulary is the authoritative one. It pins three things at compile time:
// every entry NAMES a declared event (the predicate is keyed on `keyof
// Events`), no entry BINDS a Scope (a scoped event's `ThisParameterType` is not
// `unknown`, which is how "must not depend on AgentScope" is stated statically),
// and every entry is ONE-WAY (a waterfall or bail shape returns something other
// than void and is excluded). Widening the array to an event that fails any of
// these fails here, not on the wire.
API_REMOTE_FORWARDED_EVENTS satisfies readonly TypertForwardableEvent[]

/** Host plugin body; the selected contributions mount only in Client environments. */
export function apply(): void {}
