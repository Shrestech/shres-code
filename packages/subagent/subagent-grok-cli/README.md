# @shres-code/shres-code-subagent-grok-cli

This package registers the fixed `grok-cli` subagent provider. Each accepted run starts the official Grok Build `grok -p` command in the delegating Session's workspace, submits one self-contained text task, and returns only the final answer through the shared [`shres-subagent`](../subagent/README.md) result contract.

Headless flags, JSON parse mode, auth, and effort mapping are recorded in the [Grok CLI spike](../../../.agents/notes/implemented/architecture/2026-08-16-grok-cli-headless-spike.md).

## Start and ownership

`start(request)` accepts only a non-empty sequence of text blocks and derives the child cwd from the parent Session. It resolves `grok` from `PATH` unless `executable` is set, then spawns `grok -p <task> --output-format json --always-approve --no-auto-update` through [`shres-subprocess`](../../subprocess/subprocess/README.md). A failure or cancellation before publication terminates the managed process tree and rejects `start()`.

The published `run.result` waits for process exit. Exit 0 plus a JSON object with a non-empty `result` / `text` / `message` settles as `completed`. A non-zero exit, non-JSON stdout, or an error payload settles as `error`. Local cancellation maps to `aborted`. `dispose()` is idempotent: it terminates the process tree and waits for whole-tree exit.

## Capabilities and context

The provider advertises `depthLimit` (parent-side `maxDepth` before spawn) and reports `inheritsParentContext: false`. Grok receives the standalone text task and the parent Session cwd, but not the parent conversation, persona, tool filter, or structured-output contract.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `env` | `{}` | Explicit child environment layered over the subprocess seam's credential-scrubbed parent environment. |
| `disposeGraceMs` | `3000` | Positive finite grace in milliseconds, no greater than [`MAX_TIMER_DELAY_MS`](../../util/timeout/README.md). |
| `executable` | `grok` | Absolute path or PATH name of the Grok Build binary. |

Credential-shaped ambient variables are removed by the subprocess seam, so an API key intended for the child must be supplied explicitly in `env`.

```yaml
- id: subagent-grok-cli
  name: '@shres-code/shres-code-subagent-grok-cli'
  config:
    env:
      XAI_API_KEY: !!js process.env.XAI_API_KEY

- id: tool-subagent-grok-cli
  name: '@shres-code/shres-code-tool-subagent'
  disabled: true
  config:
    provider: grok-cli
    toolName: subagent_grok_cli
    enableRunInBackground: false
    maxDepth: provider-managed
```

## Model Experience

### Child request

#### What the model sees

The Grok child receives the standalone text blocks as one `grok -p` prompt. Its workspace is the parent Session cwd. Model, tools, sandbox, and authentication come from the native Grok Build installation.

#### Token effect

The child pays for an independent Grok context. Child tokens do not enter the parent's context.

#### KV Cache effect

Independent of the parent request cache.

### Parent tool result, indirectly

#### What the model sees

Through `shres-tool-subagent`, the parent sees only the selected final Grok answer or the consumer's exact error. Grok commentary, tool activity, and product ids are not copied into the parent Session.

#### Token effect

Parent input grows only by the final answer or error retained in the tool result.

#### KV Cache effect

Append-only: the new tool result follows the reusable parent request prefix.

## Known Limitations and Deferred Work

- **One fresh process and prompt per run** — no continuation, resume, or progress stream.
- **Host-managed product installation** — a missing `grok` is a startup error; this plugin does not install or log in.
- **Grok's own tools bypass harness approval** — `--always-approve` is required for unattended one-shot runs.
- **Final text only** — reasoning, tool traffic, and workspace diffs remain product-local.
- **No remote tool filter, persona, or structured output** — those options are rejected. Parent-side `maxDepth` is enforced before spawn; recursion inside Grok is not.
