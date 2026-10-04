/**
 * Publish connection-owned MCP resources and literal server instructions.
 *
 * @module @shres-code/shres-code-mcp-client
 */

import type { Context } from '@shres-code/cordis'
import { MCP_SECTION_ORDER, type McpResourceProvider } from '@shres-code/shres-code-mcp-resources'
import type {} from '@shres-code/shres-code-system-prompt'

/** Connection-owned values used by the resource and prompt consumers. */
export interface ServerContext {
  /** Resource access through the current connection generation. */
  resources: McpResourceProvider
  /**
   * Read the last successfully connected server's attributed instructions.
   * @returns literal prompt text, or an empty string when no server instructions are active.
   */
  instructions(): string
}

/**
 * Contribute server context to the services enabled by this composition.
 * @param ctx - server plugin's registration scope and effect owner.
 * @param server - configured server identity.
 * @param connection - live resource operations and successful instruction snapshot.
 */
export function registerServerContext(ctx: Context, server: string, connection: ServerContext): void {
  ctx.inject(['mcpResources'], (inner) => {
    inner.mcpResources.register(server, connection.resources)
  })
  ctx.inject(['systemPrompt'], (inner) => {
    inner.systemPrompt.section({
      name: `mcp:${server}`,
      order: MCP_SECTION_ORDER,
      interpolate: false,
      stability: 'conditional',
      text: () => connection.instructions(),
    })
  })
}
