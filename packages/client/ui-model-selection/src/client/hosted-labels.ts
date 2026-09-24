/** Shared labels for model-route capabilities, independent of account entitlement. */
import type { ModelKey } from './locales.ts'

/**
 * Label the hosted search capabilities a route explicitly declares.
 * @param tools - Provider-declared hosted tool names.
 * @param t - Model-selection copy resolver.
 * @returns Stable tool identities with localized labels, in display order.
 */
export function hostedLabels(tools: readonly string[] | undefined, t: (key: ModelKey) => string): { tool: string; label: string }[] {
  return ([['web_search', 'hosted.webSearch'], ['x_search', 'hosted.xSearch']] as const)
    .filter(([tool]) => tools?.includes(tool) === true)
    .map(([tool, key]) => ({ tool, label: t(key) }))
}
