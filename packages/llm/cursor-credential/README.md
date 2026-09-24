# @shres-code/shres-code-cursor-credential

The one Cursor subscription-credential engine, exposed as the singleton `ctx.cursorCredential` service. It reads the login the [Cursor Agent CLI](https://cursor.com/docs) stores — the macOS login keychain items `cursor-access-token` / `cursor-refresh-token` (account `cursor-user`) that `cursor-agent login` writes by default, or the file document at `~/.cursor/auth.json` under `AGENT_CLI_CREDENTIAL_STORE=file` — and serves the access token while its JWT `exp` claim holds.

Extracted beside the `codex-credential` and `grok-credential` engines so any future capability uses the **same** token engine as the cursor routes, instead of each route owning its own credential machinery. No `CURSOR_API_KEY` is read: the subscription session is the credential.

## Service surface

`ctx.cursorCredential` exposes one operation:

- `managerFor(spec): CursorSessionManager` — returns the one manager memoized for a credential spec (`{ securityPath, authPath, useKeychain, readKeychain?, now? }`). Keying is the source facts, so callers with the same credential facts share one single-flight read per source. The memoization caches each spec key for the service's lifetime; that is safe because every `current()` call re-reads the store at the moment it runs rather than trusting cached token state.

`CursorSessionManager.current()` resolves a `CursorSessionToken`, whose one field, `accessToken`, is the bearer credential for one request. Every resolve re-reads the store, so a rotation the CLI performs is adopted on the next call without restart. Credentials never reach diagnostics: failures name the source and the `cursor-agent login` recovery step, never a value.

## Composition

```yaml
- name: '@shres-code/shres-code-cursor-credential'
```

The service has no configuration of its own — credential specs come from consumers. Mounting the plugin provides `ctx.cursorCredential`.

## Model Experience

Indirectly, through the adapter it serves; the engine itself adds no prompt, message, schema, tool, or model call.

#### KV Cache effect

No direct invalidation; the adapter and backend own any request-prefix changes.

## Known Limitations and Deferred Work

- **No self-serve refresh** — the JWT's `iss` (`https://authentication.cursor.sh`) does not resolve publicly, so this engine never runs a `refresh_token` grant: the CLI owns rotation, an expired token fails loud with `AUTH_REFRESH_FAILED` naming `cursor-agent login`, and the CLI's rotation is adopted on the next resolve. This is the deliberate deviation from the codex/grok engines, whose issuers are reachable.
- **Unofficial store** — the keychain service names and the file document's field spellings are the Cursor Agent CLI's implementation details, not a published contract; a CLI self-update can change them. The reader accepts both `accessToken` and `access_token` spellings observed in the wild.
- **Keychain reads shell out to the macOS `security` tool** — the same mechanism the CLI family uses; a locked login keychain surfaces as absence and fails with the login step.
- **Diagnostics carry the `llm-cursor-session:` prefix** — the engine names its consumer so the recovery step stays actionable wherever the error surfaces.
