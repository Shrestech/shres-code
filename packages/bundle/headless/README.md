# `@shres-code/shres-code-headless`

The shres one-shot bundle. [`cordis.patch.yml`](cordis.patch.yml) rides directly over [`shres-base`](../base/README.md): it supplies the coding persona and tool mode, disables HMR, mounts Code Mode's worker as a core execution capability, and inserts this package's `headless-runner` plugin (config `{task}`, resolved from the injected `headlessStartup` provider). It mounts no Host, HTTP server, Web runtime, or browser plugin.

The installation includes the [model router](../../llm/model-router/README.md), the [judgment dispatcher](../../llm/judgment-dispatch/README.md), and the [TypeSafe](../../llm/judgment-typesafe/README.md), [local Shield](../../llm/judgment-shield/README.md), and [local Laya](../../llm/judgment-laya/README.md) judgment providers for explicit overlays. The default bundle does not mount these plugins; [routing benchmark arms](../../../bench/README.md) select their own provider and policy.

After the Loader settles, the runner calls [`ctx.firstRunSetup.ensureReady()`](../../core/first-run-setup/README.md) when that service is composed, then reads the shared [`ctx.agentDefaultModel`](../../core/agent-default-model/README.md), creates one fresh persisted Agent through `ctx.agents`, submits the task as an ordinary user message, and waits for quiescence. It flushes the Session before folding the owned durable event interval, writes the last non-empty assistant text to stdout, and requests exit through the launcher-provided `ctx.appExit` host hook ([`shres-cmdline`](../../boot/cmdline/README.md)) (final `turn/end` completed → 0, otherwise 1). A terminal `error` reason also writes its code and message to stderr; successful runs keep stderr empty. The process opens no listening port. The task text is this app's command line: the ordinary `headless-startup` provider ([`src/startup.ts`](src/startup.ts)) injects `ctx.cmdlineArgs` ([`shres-cmdline`](../../boot/cmdline/README.md)), reads the positional argument of `shres --profile headless "task"`, prints the app's `--help`, and provides `headlessStartup`; the runner injects that service and reads its task from lazy config. A missing or whitespace-only task is rejected before the runner activates.

`--session-id <id>` creates the fresh session under the given id instead of a generated one, and `--resume <id>` continues a persisted session; the two flags are mutually exclusive, and each still requires the task positional. Resume validates before anything is published and never falls back to a fresh session: a spawn without a session-persistence backend, an unknown id, or a session whose persisted `cwd` differs from the current working directory exits 1 with a named message. A resumed spawn passes no `agentOptions` provider/model, so the durable route the log records — an explicit selection, the router's sticky state, the manual base beneath a routed header, or the last header — wins through `selectionFor → selectionInForce`, and a routed session returns to its manual base in a tree that composes no router. The summary folds only the resumed spawn's own suffix: events from the session's resume-time `seq` onward.

## Model Experience

None, as the runner submits the task as an ordinary user message; prompts and tools belong to the base and headless bundle rows.

#### KV Cache effect

None; the runner adds nothing to the request prefix.

## Known Limitations and Deferred Work

- **One submitted task per spawn** — the runner has no interactive follow-up surface; multi-turn work is one spawn per turn, resuming the same session id with `--resume`. Each spawn waits through any work the Agent completes before returning to idle and prints the last non-empty assistant message in that interval.
- **`ctx.appExit` is launcher-owned** — booting the headless profile outside the `shres` launcher fails loud at activation until the host provides the exit request.
