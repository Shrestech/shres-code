# @shres-code/shres-code-tool-grok-x-search

Four default-off, model-facing X (Twitter) search tools — `x_keyword_search`, `x_semantic_search`, `x_user_search`, and `x_thread_fetch` — that share the Grok subscription's X search with Shres agents on other routes. Each call makes one request to the `grok-session` route through `ctx.llm`, offering only that route's hosted `x_search` tool and no function tools, and returns Grok's answer with the X operations Grok reports it ran. No CLI is spawned and no child agent is created. The Grok request offers no function tools, so it cannot call these tools again.

## Enablement

The plugin owns no settings. It reads the `llm-grok-session` settings section and registers the four tools only while `enabled`, `hostedXSearch`, and `agentXTools` (default `false`) are all `true`. It follows `settings/registered`, `settings/updated`, and `settings/unregistered` for that namespace, so the tools appear and disappear without a restart and plugin load order does not matter. When the namespace is still unregistered after the Loader settled, the plugin logs one warning and the tools stay off.

The tools are registered in the global tool layer. Every agent scope inherits that layer, including subagents and agents that joined a preset, so each sees the tools unless a tool restriction on its scope chain hides them, such as a subagent `toolFilter`. They appear in the native tool list and in a code-mode agent's `run_code` SDK. No teammate or Grok-routed agent is needed. The tools reach agents whose route runs the Shres tool loop: a delegated CLI route runs its own external tools instead, and a route whose chat is gated serves no turns. On the `grok-session` route itself the hosted X search already runs, and the route drops client tools named after X call names from its request, so native Grok chat uses the hosted search rather than these tools.

Turning the tools on does not check the Grok sign-in or plan. A call fails with the route's credential error when the sign-in is missing, and with the proxy's error when the plan does not allow the request.

```yaml
- id: llm-grok-session
  name: '@shres-code/shres-code-llm-grok-session'
  config:
    agentXTools: true
- id: tool-grok-x-search
  name: '@shres-code/shres-code-tool-grok-x-search'
```

| Config | Default | Meaning |
|---|---|---|
| `model` | `grok-4.6` | Grok model id on the `grok-session` route. |
| `timeoutMs` | `180000` | Deadline of one tool call, from the start of the request to the last response chunk. |
| `maxOutputTokens` | `2048` | Output-token cap of the Grok request. |
| `maxResultChars` | `20000` | Cap on the complete rendered tool result; the answer is cut to fit. Minimum 1000. |

A blank model or a non-positive-integer limit fails at load.

## Behavior

- **Request.** The request carries a fixed system prompt, one user message holding `{ operation, query | post }` as JSON, `maxTokens`, `sessionId` of the calling session, and `hostedTools: ['x_search']`, which removes the route's hosted web search. `LlmRuntime.stream` fails the request with `UNSUPPORTED_OPTION` when the route no longer declares hosted `x_search`.
- **Record.** Before dispatch, the call appends an ignorable `grok-x-search/request` event to the calling agent's session carrying the tool name, call id, route, system prompt, messages, hosted tools, and output cap. A call without a calling agent fails instead of sending an unrecorded request.
- **Operation choice.** The tool name is a preference sent to Grok. Grok's hosted X search chooses the operations it runs; the result lists what it reported.
- **Result.** A successful result lists the distinct X operation names Grok ran, with a call count when a name repeats, and Grok's answer inside an untrusted-content frame. The complete rendered result fits `maxResultChars`: trailing operation names are left out first and counted as `N more not listed`, then the answer is cut before it is framed, so the frame stays intact. Provider call ids are not returned. The call fails when Grok ran no X search, when Grok asked for a local tool, when the stream ends with an error or abort, or when the deadline passes.
- **Arguments.** Queries are trimmed; `x_keyword_search` and `x_semantic_search` accept 1-500 characters, `x_user_search` 1-200, and `x_thread_fetch` a post URL or id of 1-300.
- **Cancellation, disable, unload.** A call stops on the caller's cancellation, on its deadline, or when this plugin unloads. Closing the settings gate withdraws the tools from later requests; a call already running keeps its authorization and finishes or times out, and a call that starts after the gate closed fails.
- **Permissions.** Like `tool-web`, the tools are read-only, run concurrently with other read-only calls, and do not request approval.

## Model Experience

### X search tools

#### What the model sees

Four tool definitions. Each description names what it asks Grok to do and states: "Grok (your Grok subscription) runs this on its servers. Shres Code sends your request to Grok and Grok chooses which X search operations to run, so it may use a different operation than this tool's name. The result lists the X operations Grok ran and cites post URLs. Each call uses Grok plan quota; it fails if Grok sign-in or plan does not allow it." A result starts with `X operations Grok ran: <names>.`, then the framed answer and a request to cite post URLs. The Grok request itself is not part of the calling conversation.

#### Token effect

The four definitions add to every request while the gate is open. Each call adds its argument and the bounded result to the calling conversation; the Grok request's tokens bill the Grok subscription, not the calling route.

#### KV Cache effect

Opening or closing the gate adds or removes four tool definitions, which invalidates the calling route's cached prefix from the tool list onward. Calls change nothing before their own tool result.

## Known Limitations and Deferred Work

- **Operations are Grok's choice** — a tool name does not force an operation, a result count, or recency.
- **Citations ride the answer text** — the pinned pi-ai dependency does not expose the hosted call's result items or URL annotations, so post URLs reach the result only as Grok writes them.
- **A Grok function call under an X call name counts as an X search** — the request declares no client tools, so pi-ai reports a hosted custom tool call and a function call under the same name identically; the result then lists that name as an operation.
- **Quota is not checked in advance** — a call reports the proxy's refusal when the plan or rate limit does not allow it.
