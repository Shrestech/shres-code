# @shres-code/shres-code-subagent-kimi-cli

This package registers the fixed `kimi-cli` subagent provider. Each accepted run starts the official Kimi Code CLI `kimi -p` command in the delegating Session's workspace, submits one self-contained text task, and returns only the final answer through the shared [`shres-subagent`](../subagent/README.md) result contract.

Headless flags, stream-json parse mode, auth, and thinking mapping are recorded in the Kimi CLI spike.

## Start and ownership

`start(request)` accepts only a non-empty sequence of text blocks and derives the child cwd from the parent Session. It resolves `kimi` from `PATH` unless `executable` is set, then spawns `kimi -p <task> --output-format stream-json --yolo` through [`shres-subprocess`](../../subprocess/subprocess/README.md). A failure or cancellation before publication terminates the managed process tree and rejects `start()`.

The published `run.result` waits for process exit. Exit 0 plus a stream-json event with a non-empty `result` / `text` / `message` settles as `completed`. A non-zero exit or a stream with no answer settles as `error`. Local cancellation maps to `aborted`. `dispose()` is idempotent: it terminates the process tree and waits for whole-tree exit.

## Capabilities and context

The provider advertises `depthLimit` (parent-side `maxDepth` before spawn) and reports `inheritsParentContext: false`. Kimi receives the standalone text task and the parent Session cwd, but not the parent conversation, persona, tool filter, or structured-output contract.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `env` | `{}` | Explicit child environment layered over the subprocess seam's credential-scrubbed parent environment. |
| `disposeGraceMs` | `3000` | Positive finite grace in milliseconds, no greater than [`MAX_TIMER_DELAY_MS`](../../util/timeout/README.md). |
| `executable` | `kimi` | Absolute path or PATH name of the Kimi Code CLI binary. |

Credential-shaped ambient variables are removed by the subprocess seam, so an API key intended for the child must be supplied explicitly in `env`.

```yaml
- id: subagent-kimi-cli
  name: '@shres-code/shres-code-subagent-kimi-cli'
  config:
    env:
      MOONSHOT_API_KEY: !!js process.env.MOONSHOT_API_KEY

- id: tool-subagent-kimi-cli
  name: '@shres-code/shres-code-tool-subagent'
  disabled: true
  config:
    provider: kimi-cli
    toolName: subagent_kimi_cli
    enableRunInBackground: false
    maxDepth: provider-managed
```

## Model Experience

### Child request

#### What the model sees

The Kimi child receives the standalone text blocks as one `kimi -p` prompt. Its workspace is the parent Session cwd. Model, tools, sandbox, and authentication come from the native Kimi Code CLI installation.

#### Token effect

The child pays for an independent Kimi context. Child tokens do not enter the parent's context.

#### KV Cache effect

Independent of the parent request cache.

### Parent tool result, indirectly

#### What the model sees

Through `shres-tool-subagent`, the parent sees only the selected final Kimi answer or the consumer's exact error. Kimi commentary, tool activity, and product ids are not copied into the parent Session.

#### Token effect

Parent input grows only by the final answer or error retained in the tool result.

#### KV Cache effect

Append-only: the new tool result follows the reusable parent request prefix.

## Known Limitations and Deferred Work

- **One fresh process and prompt per run** — no continuation, resume, or progress stream.
- **Host-managed product installation** — a missing `kimi` is a startup error; this plugin does not install or log in.
- **Kimi's own tools bypass harness approval** — `--yolo` is required for unattended one-shot runs.
- **Final text only** — reasoning, tool traffic, and workspace diffs remain product-local.
- **No remote tool filter, persona, or structured output** — those options are rejected. Parent-side `maxDepth` is enforced before spawn; recursion inside Kimi is not.
- **Older `kimi --print` binaries** — override `executable` and do not expect the shipped `-p` argv unless that binary accepts it.
