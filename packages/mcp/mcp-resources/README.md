# @shres-code/shres-code-mcp-resources

Shared MCP resource tools. The base bundle mounts this plugin once, with no config. It registers nothing until an MCP client in the same scope publishes a resource provider.

## Usage

This package has no configuration. Add a server through [@shres-code/shres-code-mcp-client](../mcp-client/README.md) in the scope that should see it. No shipped profile enables a server.

The first provider in a scope registers three tools:

- `list_mcp_resources` takes a required `server` and an optional `cursor`.
- `list_mcp_resource_templates` takes the same arguments.
- `read_mcp_resource` takes a required `server` and a required `uri`.

Removing the last provider in that scope removes those local registrations. A provider inherited from an ancestor scope stays visible. Each call resolves `server` in the calling agent's scope before any request, and the nearest scope wins a shared name. A missing server fails the tool call. The connection owner applies the client's tool-call timeout and the execution signal.

When system-prompt assembly is mounted and at least one server is visible, the conditional section `mcp-resource-servers` lists the sorted names at order 3100. `interpolate` is false, so a name that contains `{{…}}` stays literal. Empty text is omitted at render. A static section ordered at or after 3100 makes assembly fail.

## Behavior

Canonical results keep the complete JSON, including string `blob` payloads, for programmatic callers. The model-visible text starts with `MCP server: <server>`, then a newline and the JSON. Each string-valued `blob` becomes `[binary resource: <length> base64 characters; available to programmatic callers]`. A non-string `blob` stays in the JSON.

Resource requests run only when a tool is called. A disconnected server fails that call. Retrying the connection does not remove the shared tools while the client row remains.

## Model Experience

### Shared resource tools

#### What the model sees

With no caller-visible MCP server, these tools and the server-name section are absent. With one or more, the model sees `list_mcp_resources`, `list_mcp_resource_templates`, and `read_mcp_resource`. Each call names one `server`. The section text is `Use list_mcp_resources, list_mcp_resource_templates, or read_mcp_resource with one of these names as the server argument: <JSON array>.`

#### Token effect

No caller-visible server adds no tool or prompt tokens. Otherwise the three definitions are a fixed cost, and the server-name section adds one sorted JSON list. Listing and reading add tokens only when a call returns them.

#### KV Cache effect

The first caller-visible server and the removal of the last change the next tool-definition prefix. A change to the visible names updates the server-name section. Replacing a provider under the same name leaves that text unchanged. A connection failure alone does not change the definitions or the names.

### Resource results

#### What the model sees

A successful result starts with `MCP server: <server>`, a newline, and the returned JSON. Each string-valued `blob` becomes `[binary resource: <length> base64 characters; available to programmatic callers]`. Text, metadata, and continuation cursors stay visible.

#### Token effect

Rendered results add text to tool history. The binary description replaces the payload's base64. This package sets no separate text-size limit.

#### KV Cache effect

Each result appends to history. A later read can return different server content and append another result. Recorded results are not refreshed.

## Known Limitations and Deferred Work

- A server without the MCP resources capability still appears in the server-name section and keeps the shared tools available. Unsupported reads fail as tool errors.
- Resource subscriptions and update notifications are not implemented. Call list or read again for current content.
- Binary resources are not projected as images or audio. Programmatic callers keep the canonical base64.
- The tools do not aggregate servers. The caller supplies one `server` name, and pagination follows the cursor that server returns.
- MCP prompt templates, elicitation, and task-based execution are not implemented.
