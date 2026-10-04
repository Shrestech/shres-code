# @shres-code/shres-code-mcp-client

MCP client bridge plugin: connects to external [Model Context Protocol](https://modelcontextprotocol.io/) servers and registers their tools on `ctx.tools`, making them available to the model as native tools under server-qualified names (`mcp__<serverName>__<rawName>`).

## Usage

One plugin instance per MCP server in `cordis.yml`:

```yaml
- id: mcp-github
  name: '@shres-code/shres-code-mcp-client'
  config:
    serverName: github
    transport: stdio
    command: npx
    args: ['-y', '@modelcontextprotocol/server-github']
    env:
      GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN

- id: mcp-web
  name: '@shres-code/shres-code-mcp-client'
  config:
    serverName: web
    transport: streamable-http
    url: http://localhost:3000/mcp
    headers:
      Authorization: !!js '`Bearer ${process.env.MCP_TOKEN}`'
```

The model sees `mcp__github__create_issue`, `mcp__web__search`, … — the same server-qualified shape Claude Code and Codex use. HMR hot-swaps: editing the entry triggers disconnect + reconnect without process restart; an unchanged `serverName` reproduces identical tool names.

## Config

| Field | Transport | Required | Description |
|---|---|---|---|
| `transport` | both | yes | `"stdio"` or `"streamable-http"` |
| `serverName` | both | yes | Namespace for this server's model-facing tool names; `[A-Za-z0-9_-]{1,32}`, unique inside one registration scope |
| `command` | stdio | yes | Executable to spawn |
| `args` | stdio | no | Arguments passed to the command |
| `env` | stdio | no | Extra env vars merged on top of scrubbed ambient env |
| `cwd` | stdio | no | Working directory for the child process |
| `url` | http | yes | MCP server URL |
| `headers` | http | no | Extra headers (e.g. auth tokens) |
| `toolCallTimeoutMs` | both | no | Timeout per tool call and resource request (default 60000) |
| `maxInstructionBytes` | both | no | Maximum UTF-8 bytes of the attributed server-instruction section (default 32768) |
| `failOnStartupError` | both | no | Reject plugin activation when initial connection or tool synchronization fails (default `false`) |
| `reconnect.enabled` | both | no | Reconnect automatically after a lost connection (default `true`) |
| `reconnect.initialDelayMs` | both | no | First reconnect delay in ms; doubles per consecutive failed attempt (default 500) |
| `reconnect.maxDelayMs` | both | no | Backoff ceiling in ms; also the uptime after which the attempt budget resets (default 30000) |
| `reconnect.maxAttempts` | both | no | Consecutive failed attempts per outage before giving up for good (default 10) |

## Tool naming

Every MCP tool has two names: the raw MCP name (sent on the wire in `tools/call`) and the public name `mcp__<serverName>__<rawName>` registered on `ctx.tools`. Public names are normalized to the DeepSeek function-name contract (64 chars, `[A-Za-z0-9_-]`); when replacement or truncation changes the name, a deterministic 12-hex-char hash of `(serverName, rawName)` is appended so distinct tools never collapse into one name. Names are pure functions of `(serverName, rawName)` — connection order, re-syncs, and other servers never rename a tool.

- Two servers publishing the same raw name (e.g. `search`) coexist under their namespaces.
- A duplicate `serverName` inside one registration scope fails the later plugin instance at load. Separate Agent scopes may reuse a name.
- A server listing the same tool name twice is rejected as an invalid tool list.
- A foreign registration squatting on this server's namespace rolls back the whole generation (never a partial set), with a loud error.

## Behavior

- On connect: plugin activation awaits `listTools()` and registers each tool via `ctx.tools.register()` under its public name before the composition starts its first turn. Initial connection, discovery, or registration failure is always logged; it rejects activation when `failOnStartupError` is true and otherwise activates with no tools.
- Listens for `notifications/tools/list_changed` → re-syncs; a fetch-phase failure keeps the previous generation registered, while a registration conflict rolls back the attempted generation and leaves no tools from that server.
- Tool execute: `client.callTool({ name: rawName, arguments }, { signal })` with timeout + abort support—the public name is never sent to the server.
- Canonical success is `{ content: JsonValue[], structuredContent? }`; complete JSON MCP blocks survive for programmatic callers. A supported advertised `outputSchema` validates `structuredContent`; unsupported schema vocabulary falls back to unconstrained `JsonValue`.
- Native/model rendering joins text blocks with newlines. An admitted image becomes its own image block when the current model declares image input and an attachment store is mounted. A refused image, audio block, or embedded resource becomes diagnostic text. A resource link with a name and URI becomes `Resource link: <name> (<uri>)`. The execution-local canonical value keeps the raw JSON.
- On disconnect/crash: the supervisor restarts the original server config with exponential backoff (`reconnect.initialDelayMs` doubling up to `reconnect.maxDelayMs`) and re-runs discovery on success — the recovered generation replaces the previous one, so tools neither duplicate nor leak. During the outage the last good generation stays registered; calls against it fail until recovery.
- Reconnection is budgeted per outage: after `reconnect.maxAttempts` consecutive failures the server's tools are unregistered, its instruction section is cleared, and reconnection stops until an HMR reload or Host restart. A connection that survives past `maxDelayMs` resets the budget, so an occasionally-crashing server recovers indefinitely while a crash-looping one — even with briefly successful connects — still exhausts the cap instead of restarting forever.
- Reconnect states are user-visible in logs: reconnecting (warn, with attempt count and delay), recovered (info), final failure and disabled-loss (error). Disposal cancels any pending reconnect and clears the instruction section. With `reconnect.enabled: false`, a lost connection keeps tools registered but failing, and keeps the last successful instruction text, until a reload.

## Services consumed

| Service | Usage |
|---|---|
| `ctx.tools` | Register and unregister MCP tools |
| `ctx.mcpResources` | Publish this server's resource provider when the shared resource plugin is mounted |
| `ctx.systemPrompt` | Publish this server's literal instruction section when prompt assembly is mounted |

## Model Experience

### Discovered MCP tools

#### What the model sees

After initial discovery succeeds, each advertised MCP tool appears as a native tool named `mcp__<serverName>__<rawName>` (or its deterministic normalized form), with the server-provided description and input schema. A successful re-sync — including the one after an automatic reconnect — replaces the generation; plugin disposal or an exhausted reconnect budget removes it.

#### Token effect

Data-dependent schema cost is paid on every request while the tools are registered. Re-sync replaces rather than accumulates schemas, and the server-qualified name adds tokens to every tool definition and call.

#### KV Cache effect

Prefix-stable while the discovered tool set and schemas are unchanged. A re-sync that adds, removes, renames, or changes a tool replaces definitions and may invalidate reuse from the first changed schema token; a reconnect that recovers an unchanged list reproduces identical definitions and stays prefix-stable.

### Tool-call history and results

#### What the model sees

The public tool name and JSON arguments remain in assistant history. Text result blocks are joined with newlines into one retained text block. An admitted image is its own image block. A refused image, audio block, or embedded resource becomes diagnostic text, and a resource link with a name and URI becomes `Resource link: <name> (<uri>)`. The execution-local canonical value keeps the raw JSON blocks and optional structured content. MCP `isError` rejects the call through the registry's error path.

#### Token effect

Arguments and mapped text are retained until compaction. An admitted image adds an image block. Refused binary payloads and embedded resources add a short diagnostic instead of their raw bytes.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Server instructions

#### What the model sees

After a successful connection, the conditional section `mcp:<serverName>` contains `### MCP server: <serverName>` and the server's trimmed instruction text. Braces in that text stay literal. An empty instruction, a failed first connection, reconnect give-up, and dispose contribute no text. A loss with `reconnect.enabled: false` keeps the last successful text.

#### Token effect

The attributed instruction is included on every request while it is non-empty, bounded by `maxInstructionBytes` (default 32768). No instruction adds no tokens.

#### KV Cache effect

The section is ordered at 3100, after every shipped static section. Appearing, changing, or disappearing invalidates reuse from that section onward and leaves the earlier static prefix reusable.

## Known Limitations and Deferred Work

- **MCP prompts, elicitation, subscriptions, and task execution are not implemented** — resource discovery and server instructions are owned by [@shres-code/shres-code-mcp-resources](../mcp-resources/README.md) and this client's instruction section.
- **Startup timeout is inherited from the MCP SDK** — Shres does not expose a connection or discovery timeout. Each initialize or paginated `tools/list` request uses the SDK's 60-second default, so an unresponsive server or cursor chain can delay both activation and teardown while the initial synchronization settles.
- **Reconnect triggers on transport close** — a crashed stdio child fires it; Streamable HTTP failures surface per request and through the SDK transport's own SSE-stream recovery, so an unreachable HTTP server is retried per call rather than respawned by the supervisor.
- **Image admission needs a store and an image-capable route** — without either, image blocks become diagnostic text. Audio and embedded resources always become diagnostic text. The execution-local canonical value keeps the raw JSON.
- **Unsupported MCP output schemas are not enforced** — `structuredContent` falls back to `JsonValue` when the advertised schema uses vocabulary outside the harness subset.
- **An oversize instruction fails the connection attempt** — the attributed section must fit in `maxInstructionBytes`. The previous successful snapshot stays until give-up, dispose, or a later success.
