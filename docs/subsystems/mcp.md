# MCP

[`packages/mcp`](../../packages/mcp/README.md) connects the harness to external Model Context Protocol servers. [`mcp-client`](../../packages/mcp/mcp-client/README.md) is one opt-in Cordis row per server and registers that server's tools on `ctx.tools`. [`mcp-resources`](../../packages/mcp/mcp-resources/README.md) provides `ctx.mcpResources` and is mounted by the base bundle with no config. `list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`, and the `mcp-resource-servers` prompt section appear only while the caller's scope has a resource provider. No server is enabled by default.

A caller enables a server by adding an `@shres-code/shres-code-mcp-client` row in that scope. `serverName` is unique inside one registration scope, and separate Agent scopes may reuse a name. Server instructions are the conditional prompt section `mcp:<serverName>` at order 3100 with `interpolate: false`. Configuration, reconnect, image admission, and the model-facing tool text live in the package READMEs. Prompts, elicitation, resource subscriptions, and task-based execution are not implemented. The [MCP resources and instructions note](../../.agents/notes/implemented/feature/2026-10-04-mcp-resources-and-instructions.md) records why.

## Resource request

```ts type-equiv
/** One supported resource operation, with server-owned cursors and URIs. */
type McpResourceRequest =
  | { method: 'resources/list' | 'resources/templates/list'; cursor?: string }
  | { method: 'resources/read'; uri: string }
```

## Resource provider

```ts type-equiv
/** One configured server's resource access, owned by its MCP connection plugin. */
interface McpResourceProvider {
  /**
   * Run an operation against one live connection generation.
   * @param request - MCP resource method and parameters.
   * @param exec - caller identity and cancellation for this invocation.
   * @returns the protocol result as lossless JSON.
   */
  request(request: McpResourceRequest, exec: ToolExecution): Promise<JsonValue>
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmcpresources--mcpresourceruntime"></a>

### `ctx.mcpResources` — `McpResourceRuntime`

Scoped resource access plus three tools shared by configured MCP servers.

```ts cordis-catalog
/**
 * Register one server and expose resource tools while that scope has providers.
 * @param server - configured server name, unique in this scope.
 * @param provider - connection-owned resource operations.
 * @returns the effect disposer for this exact registration.
 */
register(server: string, provider: McpResourceProvider): () => void
```

Source: [`packages/mcp/mcp-resources/src/index.ts:53`](../../packages/mcp/mcp-resources/src/index.ts)
<!-- END GENERATED cordis-surface -->
