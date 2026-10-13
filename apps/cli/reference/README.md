# `shres` CLI behavior reference

This reference defines the profile, web-alias, plugin-management, and config-dump command modes. Argv is parsed once through [`src/args.ts`](../src/args.ts), and [`src/bin.ts`](../src/bin.ts) dynamically imports only the selected runner.

## Profile boot

`shres --profile <name>` boots the profile at `$SHRES_HOME/profiles/<name>`. The effective tree is composed over an empty root by applying, in order: each bundle patch named in the profile manifest's `shres.profile.bundles` list, the profile's own `cordis.patch.yml`, the home-level `$SHRES_HOME/cordis.patch.yml` (machine-local preferences shared by every profile, so it outranks the per-profile layer), and each `--patch <path>` overlay in argv order. Later layers win per row; a patch replaces the targeted row's complete `config` value rather than deep-merging keys, and may insert new rows. A parse, schema, resolution, or plugin boot failure is reported and exits nonzero. SIGINT and SIGTERM dispose the mounted root before exit.

Bundle names resolve from the shres installation first, then from the profile directory. In-box bundles (`@shres-code/shres-code-base`, `@shres-code/shres-code-web-app`, the optional `@shres-code/shres-code-browser-bundle`, and `@shres-code/shres-code-headless`) therefore always come from the same installation as the running `shres`; out-of-tree bundles come from the profile's pnpm-managed `node_modules`. A bare plugin `name` in any patch row resolves through the profile directory's Node parent-walk, which reaches the maintained installation fallback `$SHRES_HOME/profiles/node_modules` (one symlink per package the installation's app and bundles depend on, healed on every launch).

The `web` and `headless` profiles auto-initialize from shipped templates on first use (`web`: base + web-app; `headless`: base + headless). Any other missing profile fails loud with a hint to run `shres plugin --profile <name> add <package>`.

### App arguments

The launcher's flags come first and end at the first token it does not recognize; everything from there on is handed to the booted profile verbatim through `ctx.cmdlineArgs`, where any injected app plugin may parse it ([`shres-cmdline`](../../../packages/boot/cmdline/README.md)). `shres --profile web --port 8080` therefore reaches the web app's `--port`, `shres --profile web --help` prints that app's help and boots nothing, and `shres --help` (no profile to hand it to) prints the launcher's own. `-V`/`--version` prints the launcher's version when it appears before the app-argument boundary.

A composition mounts once. An ordinary plugin injects `cmdlineArgs`, parses this app's arguments, and provides what it resolved as a service; each row configured from flags injects that service, and Loader waits for it before evaluating the row's config (`port: !!js ctx.webStartup.port ?? 3080`). A flag therefore beats the value written beside it. This precedence requires the row to retain that expression; a user patch that replaces the whole `config` with literals removes the runtime read. Help and rejected arguments request exit — nonzero for a rejection, 0 for help — without activating rows that depend on the provider's service. A live `cordis.patch.yml` edit re-evaluates expressions against services that are still up, so it cannot reset a served port.

Launcher flags must come before app arguments, and the launcher's parser consumes one `--`: an app argument that must arrive as a literal `--` needs `-- --`. A first app argument equal to `web` or `plugin` selects that subcommand instead. `ctx.cmdlineArgs.get()` is a shared immutable read: multiple plugins may parse the same snapshot, while a profile with no reader ignores its app arguments.

The shipped apps own these command lines:

| Profile | Arguments |
|---|---|
| `web` | `--host`, `--port`, repeatable `--trusted-host` |
| `headless` | the task text, as the positional argument |

A one-shot task (`shres --profile headless "run the tests"`) creates one fresh persisted Agent through the core registry, submits the task, waits for quiescence, and flushes the Session before deriving the last non-empty assistant text and final `turn/end` reason from its durable interval. It prints the text on stdout and exits 0 for `completed`, else 1. An invocation with no task is a usage error from that app. The shipped headless profile mounts no ApiProxy, Host, HTTP server, Web runtime, or browser client; a successful run writes nothing to stderr and opens no listening port.

Inspect the composed tree without booting it:

```sh
shres --profile web --dump-default-config
shres --profile web --patch ./extra.yml --dump-config
```

`--dump-default-config` prints only the bundle layers; `--dump-config` adds the profile's `cordis.patch.yml`, the home-level `$SHRES_HOME/cordis.patch.yml`, and `--patch` overlays. Both print comments naming the file that supplied each row and every overlay that changed it; `!!js` expressions remain unevaluated, and unmatched patch targets are reported on stderr. A dump never runs app command-line providers, so it shows the composed tree before any app argument is resolved and rejects an invocation that carries app arguments. A dump and a profile boot both take the profile's plugin lock while they recover an interrupted plugin operation and load the profile; each refuses with the owning process id while a managed install or removal holds the profile, and names another `shres` process when its lock is still held after the wait.

## Plugin management

### Managed installation and removal

`shres plugin --profile <name> install-plugin <spec> [--yes]` installs one Shres bundle through the shared [profile installer](../../../packages/boot/app-boot/README.md). An interactive terminal shows the resolved package preview and asks for confirmation before activation. Non-interactive use requires `--yes` and otherwise exits before installing. Successful activation changes the next profile boot, not an already-running process.

Local directories are retained as profile-owned snapshots, not live links to the original directory; explicit `link:` specifications and local dependency references outside the snapshot are refused. Dependency lifecycle scripts are disabled. Packages requiring a build step, including transitive dependencies, are refused rather than built automatically. A package declaring only another harness’s bundle format is not Shres-compatible. The expert command below retains pnpm’s broader operations and must be used deliberately.

`shres plugin --profile <name> remove-plugin <name> [--yes]` confirms and deactivates a managed plugin before removing its package. A running process retains its loaded code until restart. These managed commands do not update existing plugins. The installer owns locking, interrupted-operation recovery, and the limits of restoring packages after failure; see its README before manually clearing a stale lock.

### Expert pnpm forwarding

`shres plugin --profile <name> <args...>` initializes the profile when missing (shipped template, or `@shres-code/shres-code-base` alone for other names), then forwards `<args...>` to `pnpm` with the profile directory as working directory — `add`, `remove`, `why`, `update`, and every other pnpm verb work unchanged; pnpm must be on PATH. Relative path specs (`.`, `../plugin`, and their `file:`/`link:` forms) are anchored to the invoking directory first, so `add .` from a plugin checkout installs that checkout, not the profile. After every successful run, `shres.profile.bundles` is reconciled against the installed state: each dependency resolving to a package whose manifest declares `"shres": { "bundle": { "patch": "./cordis.patch.yml" } }` joins the layer stack (so an `update` that gains the declaration activates it), a bundle-less dependency stays plain with a one-time warning, and a removed dependency leaves the stack.

```sh
shres plugin --profile tui add github:shres-code/turtle-ui
shres plugin --profile tui remove turtle-ui
shres --profile tui
```

Git-hosted plugins that ship sources build during install through their `prepare` script, which pnpm ≥10 blocks until the consumer allows it: the first `add` fails with pnpm's `allowBuilds` hint (and a shres pointer at the profile's `pnpm-workspace.yaml`); copy the printed key there and re-run. Installing a built tarball or a local checkout needs no allowance.

## Installed skills

`shres skill add <directory>` copies a local directory containing `SKILL.md` into `$SHRES_HOME/skills-installed`. It does not fetch repositories, execute the skill, install external programs, or connect browser extensions. Installed skills are untrusted and have lower precedence than project, user, bundled, and runtime skills. Discovery watches the installed directory, so successful copies do not require a profile restart.

`shres skill list` prints the managed installation records. `shres skill remove <name>` removes only a managed copy, not an arbitrary user-authored skill. The offline CLI checks filesystem name conflicts but cannot inspect skills registered by a running plugin or agent preset. The web host additionally checks its global catalog; preset-specific overrides remain outside that check. Filesystem validation, copying, provenance, and removal rules belong to [skill-filesystem](../../../packages/skill/skill-filesystem/README.md).

## Web alias

`shres web` is a hardcoded alias for `--profile web`; the flags after it belong to the web app, whose ordinary bundle provider parses them. `--host` and `--port` override the composed values of the rows that carry them, and repeatable `--trusted-host` contributes invocation authorities through `ctx.webRuntime.trustedHosts` (a deployment expression concatenates its own authorities). The client-plugin HMR receiver is always mounted and stays idle until a separate `pnpm run dev:web` watcher rebuilds client bundles.

```sh
shres web
shres web --patch ./extra.cordis.yml
shres web --dump-config
shres web --help
```

The production Web runner needs built package and frontend artifacts (`pnpm run build`). It serves `http://127.0.0.1:3080` by default. The CLI intentionally does not support `--host 0.0.0.0` yet and exits with a usage error; `--trusted-host` adds named authorities accepted by the `/api` browser-trust fence.

Process shutdown gives the plugin tree up to five seconds to dispose. The first `SIGINT`/`SIGTERM` starts that graceful drain — `SIGTERM` is a supervisor's ordinary stop request and exits 0 on every surface, `SIGINT` reports 130; a second signal forces immediate exit. If one-shot normal completion is already stuck in disposal, the first `Ctrl+C` is the escalation and exits immediately instead of being swallowed.

All modes treat the invoking directory as the default workspace root, load applicable `AGENTS.md` or `CLAUDE.md` instructions with a 65,536-byte render budget, and use an in-memory SQLite session content index. Every profile boot watches valid edits of both `cordis.patch.yml` layers (profile and home) and reapplies them transactionally; a one-shot surface exits through its bounded shutdown, which disposes the watchers.

New sessions default to the `workspace-write` permission preset. Bash and filesystem mutations are restricted to the session workspace and platform temporary roots; reads and process visibility are not confined. Confined bash denies outbound network by default, including local socket connections on macOS. Network policy is deployment-wide; `danger-full-access` runs bash unconfined. `SHRES_PERMISSION_MODE` changes the process fallback. Stored General-settings permissions affect later Web sessions, not an already-open one.

`SHRES_TOOLS_MODE` selects `native`, `code`, or `both` for the process; another value fails at boot. The shipped `minimal` agent preset keeps that deployment presentation, fixes the complete system prompt to `You are a helpful software engineer assistant.`, and composes only persistent `bash` plus `str_replace_editor`. Select Minimal mode when creating a Web session; every other prompt section and model-facing plugin remains absent from that agent while the shared browser, workspace, persistence, sandbox, and permission host stays in place.

## Shared deployment behavior

The base bundle mounts the native DeepSeek adapter, settings and credential providers, stable `web_search`, and disabled session telemetry. Provider credentials resolve from the inherited environment, `$SHRES_HOME/.credentials.yaml`, the invoking directory's `.env`, then `$SHRES_HOME/.env`; the managed document is never materialized into `process.env`, while both `.env` files are ordinary launch environment layers. Search uses `DEEPSEEK_API_KEY` and accepts `DEEPSEEK_SEARCH_BASE_URL`; `web_fetch` is disabled unless a patch layer inserts a provider and enables it.

Session telemetry stays local by default. `SHRES_TELEMETRY_MODE=FULL` streams every projected session event as OTLP/HTTP logs, while `SHRES_TELEMETRY_MODE=FEEDBACK_ONLY` uploads a session-log suffix only when feedback is recorded. `SHRES_TELEMETRY_OTLP_URL` selects another collector, and any non-empty `SHRES_TELEMETRY_DISABLED` remains an authoritative hard opt-out. The shipped base has no telemetry redaction rule, so explicitly enabled exports can contain message text, tool arguments and results, and workspace paths.

Install compatible external bundles through `shres plugin --profile <name> install-plugin <package-or-git-spec>`; the expert pnpm path bypasses its consent and validation. The installed package owns its dependencies and contributes its declared `cordis.patch.yml` layer. The CLI ships `@shres-code/shres-code-mcp-client` for patch layers, and the base bundle mounts `@shres-code/shres-code-mcp-resources`, which stays quiet until a client row exists in the caller's scope. No MCP server is enabled by default because each server command is trusted executable code outside the agent sandbox.

## Source execution

From the repository root, run `pnpm run build` separately after a fresh checkout and whenever artifacts need updating, then use `pnpm shres <args...>`. The `package.json` script launches `apps/cli/src/bin.ts` with `node --import tsx/esm` without building and forwards every argument. Missing Typert host artifacts fail profile boot through module-resolution errors without a build instruction. Once those host artifacts exist, missing frontend or client-plugin bundles fail at startup with an instruction to run `pnpm run build`. The launcher does not check freshness, so existing stale bundles can run older browser code until rebuilt. The process inherits the launch environment; set `NODE_USE_ENV_PROXY=1` when a supporting Node version must honor `HTTP_PROXY` and `HTTPS_PROXY`. The installed form launches the built `apps/cli/lib/bin.js` without rebuilding the repository.
