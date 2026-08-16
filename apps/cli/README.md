# `@roos-code/roos-code`

English | [中文](README.zh.md)

The `roos` command is the product launcher for profiles: ordered stacks of plugin-bundle patch layers under the user's own overrides. [`src/args.ts`](src/args.ts) owns the command grammar, and [`src/bin.ts`](src/bin.ts) loads only the selected runner. Invalid commands, options from another mode, configuration errors, and boot failures exit nonzero.

## Entry modes

| Command | Purpose |
|---|---|
| `roos --profile <name>` | Boot the named profile under `$ROOS_HOME/profiles/<name>`. |
| `roos --profile headless "job"` | Run one fresh persisted session, print the final answer, and exit. |
| `roos web` | Alias of `--profile web`. |
| `roos plugin --profile <name> <pnpm args>` | Manage a profile's plugins by forwarding to pnpm in the profile directory. |

The invoking directory is the default workspace root. The `web` and `headless` profiles auto-initialize on first use from shipped templates; any other profile must be created through `roos plugin`.

## App arguments

The launcher parses only its own flags and hands everything after them to the booted profile, where any injected app plugin may parse the shared immutable snapshot ([`roos-cmdline`](../../packages/boot/cmdline/README.md)). Launcher flags therefore come first, and the first token the launcher does not recognize starts the app's arguments:

```sh
roos --profile web --port 8080       # --port belongs to the web app
roos --profile tui --resume <id>     # example, assuming the tui profile is installed; --resume belongs to the terminal app
roos --profile headless "run the tests"
roos --profile web --help            # the web app's flags, not the launcher's
roos --help                          # the launcher's own help
```

## Profiles

A profile directory holds a `package.json` (out-of-tree plugin dependencies plus the profile manifest `roos.profile` with its ordered `bundles` list) and a `cordis.patch.yml` (the user's own patch layer).

The tree composes over an empty root:
- each bundle's patch in `roos.profile.bundles` order
- then the profile's `cordis.patch.yml`, then the home-level `$ROOS_HOME/cordis.patch.yml`
- then `--patch` overlays

Bundles named in `roos.profile.bundles` resolve from the roos installation first (`@roos-code/roos-code-base`, `@roos-code/roos-code-web-app`, `@roos-code/roos-code-headless`), then from the profile's own `node_modules`, where pnpm installs out-of-tree plugins.

Use `--dump-default-config` and `--dump-config` to inspect the composed tree without booting it.

The [CLI behavior reference](reference/README.md) owns exact layer precedence, flags, shutdown behavior, deployment defaults, and source execution.

## Development

Production runs require built package and frontend artifacts. From the repository root, run `pnpm run build` separately, then use `pnpm roos <args...>` to run the TypeScript entry and forward every argument; the [source-execution reference](reference/README.md#source-execution) owns the module-resolution contract.
