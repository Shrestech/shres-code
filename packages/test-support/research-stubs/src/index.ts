/**
 * Keyless stub debate seats for researcher snapshot scenarios: `aegis` and
 * `ward` echo fixed, deterministic digests so a replayed session can complete
 * the design-defense gate without a model call or a forked child.
 *
 * @module @shres-code/shres-code-research-stubs
 */

import type { Context } from '@shres-code/cordis'
import { defineTool } from '@shres-code/shres-code-tools'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'research-stubs'

/** Required services. */
export const inject = ['tools']

/** Fixed feasibility digest the aegis stub returns. */
export const AEGIS_DIGEST
  = 'STUB AEGIS: design is feasible within the declared budget; one probe run answers the open question.'

/** Fixed challenge digest the ward stub returns. */
export const WARD_DIGEST
  = 'STUB WARD: no confound found; the baseline is stated and the metric supports the claim.'

/**
 * Pure call presenter for both stub seats.
 * @param _args - the (empty) call arguments.
 * @returns the generic card view.
 */
export function presentStubCall(_args: Record<string, never>): { card: 'generic'; title: string; kind: 'other'; rawInput: Record<string, never> } {
  return { card: 'generic', title: 'research-stubs seat', kind: 'other', rawInput: {} }
}

const seatTool = (seatName: string, title: string, digest: string) => defineTool({
  name: seatName,
  description: `Stub ${title} debate seat for keyless researcher snapshots; returns a fixed digest.`,
  parameters: {},
  output: {
    schema: { type: 'object', additionalProperties: false, properties: { digest: { type: 'string' } } },
    render: () => [{ type: 'text', text: digest }],
  },
  execute: () => Promise.resolve({ digest }),
  presentCall: presentStubCall,
})

/**
 * Register the two stub seats.
 * @param ctx - Cordis context with the tools service.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(seatTool('aegis', 'aegis feasibility', AEGIS_DIGEST))
  ctx.tools.register(seatTool('ward', 'ward challenge', WARD_DIGEST))
}
