# shres-tool-call-timeout-policy

Tool-call timeout enforcer: a single `tools/execute` around-dispatch listener that arms a per-call cooperative deadline on `exec.signal` and returns a structured `TOOL_TIMEOUT` result when that deadline wins. The budget comes from the tool's own declaration (`ToolDefinition.timeoutMs`, set by the owning tool plugin), or from the deployment's `defaultTimeoutMs` for the tools that declare none. It is the reference `tools/execute` wrapper and the enforcement home for model-facing tool-call budgets.

## Plugin (namespace: `timeout-policy`)

A function/namespace plugin (`name` / `inject` / `Config` / `apply`), not a service. It registers no tool — it consumes `ctx.tools`'s `tools/execute` waterfall (which the `shres-tools` registry always provides) and reads each dispatched tool's declared `timeoutMs` from the registry (`ctx.tools.get(exec.name)`).

```yaml
- id: timeout-policy
  name: '@shres-code/shres-code-tool-call-timeout-policy'
  config:
    defaultTimeoutMs: 600000   # absent by default: undeclared tools get no deadline
```

The per-tool budget is declared by the tool plugin (e.g. `shres-tool-web`'s `fetchTimeoutMs`/`searchTimeoutMs`/`researchTimeoutMs` config, attached as `ToolDefinition.timeoutMs`); this plugin only enforces it, so a mistyped tool name is not possible. `defaultTimeoutMs` fails loud at plugin load: anything but a positive integer throws, never a silent fall-back. It is absent by default, so adding this plugin changes no shipped behavior; a deployment that wants the workhorse tools (`bash`, `read`, `write`, `edit`, which declare nothing) covered sets it.

### Behavior

For a call whose tool **declares a `timeoutMs`**, or any call at all once `defaultTimeoutMs` is configured, the listener:

1. Resolves the budget — the tool's own declaration if it has one, otherwise `defaultTimeoutMs` — and arms `deadline(exec.signal, timeoutMs, 'TOOL_TIMEOUT')`, one signal fusing the caller's abort with this plugin's timer (`@shres-code/shres-code-timeout`).
2. Swaps that derived signal onto `exec` for the downstream dispatch, then restores the caller's own signal afterward (cordis `next()` ignores passed arguments, so the wrapper mutates the shared `exec` in place; restoring keeps `tools/post-execute` seeing the caller's signal).
3. After dispatch, if `timeoutOf(d.signal, 'TOOL_TIMEOUT')` matches — this plugin's own timer fired — replaces the result with a structured `TOOL_TIMEOUT` tool result: `{ isError: true, error: { message, info: { name: 'ToolTimeoutError', code: 'TOOL_TIMEOUT' } }, content: 'Error: tool call timed out after <ms>ms' }`.

A declaration wins in both directions: it raises a tool above a short `defaultTimeoutMs` and holds a tool below a generous one. With no declaration and no configured fallback the call delegates untouched (no deadline).

The base `next()` of `tools/execute` is the registry's dispatch-with-normalization thunk, so when the timeout signal reaches a provider that throws its own upstream-abort error, dispatch first turns it into a normal error result, and this wrapper then replaces that with `TOOL_TIMEOUT`. That ordering is why the replacement is keyed off the signal (`timeoutOf`), not off the dispatched result's shape.

### Cooperative, not a hard kill

The derived signal only **notifies**; termination stays with the tool and the capability it forwards `exec.signal` to (the `shres-timeout` library owns no kill). **Declaring `timeoutMs` therefore means "cooperative with `exec.signal`"**: a tool that ignores the signal will not stop on timeout. Only signal-forwarding tools should declare it — the shipped `web_fetch`/`web_search` (which forward through `ctx.web` to providers) are the reference. `defaultTimeoutMs` extends the same cooperative deal to tools that never opted into it, so a deployment that sets it accepts that an uncooperative tool reports `TOOL_TIMEOUT` to the model while its work continues in the background; the value belongs well above any honest run of the slowest covered tool. `TOOL_TIMEOUT` needs no session event for reconstructability: it is the final model-facing `tool/result`, already logged by the loop.

### Composing with other `tools/execute` wrappers

Multiple `tools/execute` listeners compose by cordis registration order. Combined with a future retry/sandbox/metrics wrapper, registration order chooses the semantics — "timeout covers the whole retry operation" (timeout registered outer) versus "timeout covers each attempt" (timeout registered inner).

## Model Experience

### Conditional tool result

#### What the model sees

This plugin adds no prompt or schema. If a deadline wins, it replaces the provider's outcome with `Error: tool call timed out after <ms>ms` plus structured `TOOL_TIMEOUT`; otherwise the original result passes through unchanged. The message quotes the budget that fired, so the model cannot tell a declared budget from the deployment default — which is correct: neither is its concern.

#### Token effect

Zero tokens on non-timeout calls. A timeout adds one small retained error result and can prevent a larger late provider result from entering context.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Cooperative, never a hard kill** — the deadline only notifies via `exec.signal`; a tool that ignores the signal does not stop on timeout (see § Cooperative, not a hard kill).
- **One fallback for every undeclared tool** — `defaultTimeoutMs` is a single registry-wide number; there is no per-tool override in this plugin's config, so a deployment needing different budgets for `bash` and `read` must have those tools declare their own.
- **No default fallback ships** — `defaultTimeoutMs` is absent unless a deployment sets it, so out of the box `bash`/`read`/`write`/`edit` still run without a deadline.
- **A tool cannot refuse the fallback** — the registry rejects a non-positive `ToolDefinition.timeoutMs`, so "never deadline me" has no spelling; a tool that must never be interrupted (the filesystem package's [recorded refusal of file-IO deadlines](../../fs/README.md#no-timeouts-on-file-io)) is covered anyway once a deployment configures the fallback. The definition-level opt-out is deferred with the harness-hardening plan.
