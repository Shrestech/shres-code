# MCP — Model Context Protocol

These packages connect the harness to external Model Context Protocol servers. A server exists only as an opt-in client row. The shared resource service stays quiet until that row is active in the same scope.

| Package | Role | ctx key |
|---|---|---|
| [`mcp-client/`](mcp-client/README.md) | Connects one external server and registers its tools, instructions, and resource operations | registers tools on `ctx.tools` and one provider on `ctx.mcpResources` |
| [`mcp-resources/`](mcp-resources/README.md) | Shared resource tools and the conditional server-name prompt section | `ctx.mcpResources` |

Resource requests, the provider contract, and `ctx.mcpResources` are documented in [docs/subsystems/mcp.md](../../docs/subsystems/mcp.md). The MCP resources and instructions note records why instructions stay literal and why no server ships enabled.
