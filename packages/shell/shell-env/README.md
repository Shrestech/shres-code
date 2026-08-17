# @shres-code/shres-code-shell-env

The tool-independent shell environment plugin: owns the `ctx.shellEnv` registry of trusted, per-execution `SHRES_*` variables that the model-facing shell tools (`shres-tool-bash`, `shres-tool-pwsh`) collect into every shell call's environment. Built-in shell facts (`SHRES_HOME`, `SHRES_SHELL=1`, `SHRES_SESSION_ID`) are owned by the registry itself; other plugins register additional enumerable facts with effect-scoped disposal, and duplicate ownership or undeclared runtime keys fail loudly.

The package root exports the Cordis plugin contract (`name`, `inject`, `Config`, `apply`) plus the `ShellEnvRegistry` service class and its contributor types; consumers use `ctx.shellEnv` after loading this plugin.

## Config

```yaml
- id: shell-env
  name: '@shres-code/shres-code-shell-env'
  config:
    shresHome: C:\Users\me\.shres   # default: $SHRES_HOME, then ~/.shres
```

## Managed environment

Every foreground and background model shell call receives a newly collected trusted `SHRES_*` environment. `SHRES_HOME` is the absolute Harness home resolved by [`@shres-code/shres-code-home-paths`](../../util/home-paths/README.md) (`shresHome` config, then ambient `$SHRES_HOME`, then `~/.shres`) and `SHRES_SHELL=1` identifies the managed child. Agent calls additionally receive `SHRES_SESSION_ID=agent.session.header.id`; when the active persistence seam locates a JSONL artifact they also receive `SHRES_SESSION_JSONL=<absolute target path>`. The JSONL path is a location hint: it may not exist before the first flush or contain the current buffered turn, and it is not an authorization credential.

`ctx.shellEnv` owns collection. Other plugins can register an effect-scoped contributor with a stable name, declared keys/descriptions, and `resolve(execution: ToolExecution)`; duplicate ownership and undeclared runtime keys fail loudly, while `list()` enumerates declarations without executing providers. Harness built-ins reserve `SHRES_HOME`, `SHRES_SHELL`, and `SHRES_SESSION_ID`; this plugin's persistence translator owns `SHRES_SESSION_JSONL` by reading the backend-neutral `sessionPersistence.locate()` seam.

```ts
import type { Context } from '@shres-code/cordis'
import type {} from '@shres-code/shres-code-shell-env'

export const inject = ['shellEnv']

export function apply(ctx: Context): void {
  ctx.shellEnv.register({
    name: 'deployment-region',
    variables: { SHRES_DEPLOYMENT_REGION: { description: 'Current deployment region.' } },
    resolve: execution => execution.agent === undefined ? {} : { SHRES_DEPLOYMENT_REGION: 'cn-north' },
  })
}
```

The overlay is computed from the current `ToolExecution` and passed through the dedicated `ShellExecRequest.shresEnv` channel. The local executors remove all inherited `SHRES_*` before merging that snapshot, so nested harnesses and concurrent parent/child agents cannot leak stale identities. `process.env` is never modified. The shell tools' descriptions teach the generic `$SHRES_*` convention rather than naming persistence-specific variables or adding a permanent system-prompt section.

## Model Experience

Indirectly, through the shell tools (`shres-tool-bash`, `shres-tool-pwsh`), which collect this registry's managed `SHRES_*` snapshot into every shell-tool call.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.

## Known Limitations and Deferred Work

- **`list()` enumerates contributor-declared variables only** — registry-owned built-ins (`SHRES_HOME`, `SHRES_SHELL`, `SHRES_SESSION_ID`) are not included, so diagnostics, prompt, or UI code must not treat `list()` as an exhaustive environment catalog.
