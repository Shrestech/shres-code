# Agent Note: MCP resources, server instructions, and admitted images

Status: implemented

## Problem

The MCP client registered tools and dropped every other server capability. A configured server's instructions never reached the model. Resource documents had no on-demand reader. Image results became placeholders even when the model accepts images and an attachment store is mounted. `serverName` uniqueness was process-global, so two agents could not each connect to a server that reused a local name. Server text that contains `{{…}}` would be interpolated as a prompt variable or fail assembly.

## Decision

The base bundle mounts `@shres-code/shres-code-mcp-resources` with no config. The plugin registers `list_mcp_resources`, `list_mcp_resource_templates`, and `read_mcp_resource` only while the caller's scope has at least one MCP resource provider. No shipped profile enables a server. A caller adds one with an `@shres-code/shres-code-mcp-client` row in that scope.

Each tool takes an explicit `server` argument. List and template calls accept an optional `cursor`. `read_mcp_resource` also takes `uri`. The runtime resolves the provider in the caller's scope: the nearest scope's registration wins a name, and a missing name fails before any request. The first provider in a scope registers the shared tools. Removing the last provider removes those local registrations. Inherited providers stay visible.

A successful connection stores the server's instructions as a conditional system-prompt section named `mcp:<serverName>`, ordered at 3100, with `interpolate: false`. The text is `### MCP server: <serverName>` followed by the trimmed server text. Instructions longer than `maxInstructionBytes` (default 32,768 UTF-8 bytes, counted after that attribution) fail that connection attempt. The snapshot stays through reconnect attempts and through a loss when `reconnect.enabled` is false. Give-up and dispose clear it. A failed retry keeps the previous snapshot until a later success replaces it.

The visible server list is a second conditional section, `mcp-resource-servers`, at the same order. Empty text is dropped at render. A static section ordered at or after 3100 makes assembly fail, because every conditional section must follow every static section. Two conditional sections may share 3100.

`serverName` is unique inside one registration scope (`scopeOf(ctx) ?? ctx.root`). Separate Agent scopes may reuse it. A duplicate in one scope fails the later instance at load.

Image blocks in a tool result go through the attachment service when the current model route declares image input. The canonical tool value keeps the raw MCP JSON, including base64. Admitted images become image content blocks. A refused image, an audio block, or an embedded resource becomes diagnostic text. A resource link with a name and URI becomes `Resource link: <name> (<uri>)`. In a resource result, a string `blob` is replaced only in the model-visible text, by a description of its base64 length.

The client stays on `@modelcontextprotocol/sdk` 1.30. Prompts, elicitation, task-based execution, and resource subscriptions are not implemented. Shipped examples do not enable an MCP server, so keyless snapshot prompts stay unchanged. Unit tests pin the new prompt text and tool results.

## Alternatives considered

**Stay on MCP SDK 1.30.** SDK 2 and protocol 2026-07-28 would renegotiate every existing server connection. SDK 1.30 already exposes `getInstructions`, `listResources`, `listResourceTemplates`, and `readResource`, which is the protocol this port uses.

**Do not ship a bundled server.** A server command is trusted executable code outside the agent sandbox. Shipped profiles mount only the shared resource plugin, and it stays quiet until a caller adds a client row.

**Keep server instruction braces literal.** Server text is untrusted and may contain braces that are not prompt variables. `interpolate: false` preserves that text without an inline escape and without failing the connection.

**Admit images through attachments.** The attachment service and image content blocks already exist. A model that declares image input receives the admitted image. Every other case stays diagnostic text, and programmatic callers still see the raw payload.

## Consequences

Profiles that add an MCP client also show the three shared resource tools and, when the server sends instructions, a literal instruction section. Profiles that add none stay unchanged. The request and provider types live on [docs/subsystems/mcp.md](../../../../docs/subsystems/mcp.md).

A static prompt section at order 3100 or above fails assembly while these conditional sections are registered. Shipped static sections stay below that order. The two MCP sections share order 3100, and registration order breaks that tie.

`maxInstructionBytes` is config. An oversize instruction fails the connection attempt and leaves the instruction section empty until a later success.

Image admission depends on a mounted attachment service and a model route that includes image input. Without either, the model sees diagnostic text and the canonical value still holds the raw image.

MCP prompts, elicitation, subscriptions, and task execution remain absent.

## Testing

Unit tests cover scoped provider lifecycle, resource forwarding, blob redaction, literal instruction rendering, instruction clearing on give-up and dispose, scope-local `serverName`, image admission and refusal, and the `interpolate: false` prompt flag. The keyless MCP client end-to-end test expects diagnostic image text because it does not mount an attachment store. Shipped snapshot compositions do not enable an MCP server.
