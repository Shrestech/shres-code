# @shres-code/shres-code-llm-cursor-session

Cursor subscription-session adapter for the LLM seam. Registers one provider route, `cursor-session`, that serves the model catalog the Cursor Agent CLI validated against its live backend, authenticated with the CLI's own login credential — the macOS login keychain's `cursor-access-token` (account `cursor-user`) that `cursor-agent login` writes, or the file store under `AGENT_CLI_CREDENTIAL_STORE=file` — resolved through the shared [`shres-code-cursor-credential`](../cursor-credential/README.md) engine. Using the route bills the Cursor subscription (Pro/Pro+/Ultra), not a `CURSOR_API_KEY`.

The adapter is HTTP-based and spawns nothing, unlike a `cursor-cli` overlay route on [`shres-code-llm-cli-bridge`](../llm-cli-bridge/README.md), which runs the `cursor-agent` binary. Because Cursor's agent wire is a proprietary, undocumented protocol (`agent.v1.AgentService/Run` on `agentn.global.api5.cursor.sh`, Connect/gRPC framing with a client handshake this package does not replicate), `stream()` currently fails loud: model listing and resolution are live, completions are not — a hand-declared `cursor-cli` overlay route remains the serving path until the wire is cracked.

## Session credential

The credential comes from [`ctx.cursorCredential`](../cursor-credential/README.md): `current()` re-reads the store on every resolve, so a re-login or the CLI's rotation is adopted on the next call without restart. The token's JWT `exp` is validated; an expired token fails with `AUTH_REFRESH_FAILED` naming `cursor-agent login` (the issuer the JWT names does not resolve publicly, so this engine never runs a refresh grant itself), and an absent login fails with `MISSING_CREDENTIAL` before any request is attempted. Diagnostics never quote credential values.

## Configuration

The optional `llm-cursor-session` settings section overlays the composition entry (the whole section is the one route's profile):

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` keeps the Models directory entry but withdraws the live route. |
| `baseURL` | `https://api2.cursor.sh` | Endpoint base for the JSON RPC family. |
| `securityPath` | `/usr/bin/security` | macOS security tool the keychain source reads through. |
| `authPath` | `~/.cursor/auth.json` | File-store document, used when `useKeychain` is false. |
| `useKeychain` | true on macOS | Read the login keychain instead of the file store. |
| `models` | the six verified ids below | Advisory catalog; a new backend release is a settings entry, not a code change. An explicit empty array is rejected — it would remove the route's picker group; omit the field to inherit the shipped catalog. |

Shipped catalog (ids cursor-agent validated against the live backend): `gpt-5.2`, `claude-4.5-sonnet`, `cursor-grok-4.6-high`, `cursor-grok-4.6-high-fast`, `claude-fable-5-1-thinking-high`, `gemini-3.8-flash-high`.

## Model Experience

### Subscription catalog request

#### What the model sees

Nothing yet: `stream()` fails before any request is built. When the wire is served, requests will carry the standard harness conversation over the agent protocol.

#### Token effect

None: no request is sent.

#### KV Cache effect

None: no request is sent.

## Known Limitations and Deferred Work

- **Chat is gated on an undocumented handshake** — the agent wire (`agent.v1.AgentService/Run`, BiDi Connect streams on `agentn.global.api5.cursor.sh`) accepts the conversation state and checkpoints it, but model turns do not start without a client behavior byte-level replay could not reproduce (14 systematic variants: exact bytes, headers, timing, keepalives, session affinity, blob keys, body compression). `stream()` fails loud with `UNSUPPORTED_OPTION` naming the `cursor-cli` overlay alternative.
- **The directory advertises the gate** — the configurable-provider entry carries `chatGated: true`: usability checks do not count the route as servable, and model selection refuses it with `model-unavailable` before the selection is applied or persisted. The [`cursor-cli` overlay](../llm-cli-bridge/README.md#worked-example-a-cursor-cli-overlay) remains the serving path for Cursor completions.
- **No self-serve credential refresh** — the JWT issuer (`authentication.cursor.sh`) does not resolve publicly; the CLI owns rotation and this route adopts it on the next resolve. See the [credential engine](../cursor-credential/README.md).
- **Unofficial wire and store** — the keychain service names and the agent protocol are the Cursor Agent CLI's implementation details, not a published contract; a CLI self-update can change them.
- **Catalog is advisory** — served from the shipped list or the settings overlay; it is not fetched live from `AvailableModels` (that endpoint is trivially available over JSON+Bearer and is the natural next step when chat lands).
