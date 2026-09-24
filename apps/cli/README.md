# `@shres-code/shres-code`

The `shres` command is the product launcher for profiles: ordered stacks of plugin-bundle patch layers under the user's own overrides. [`src/args.ts`](src/args.ts) owns the command grammar, and [`src/bin.ts`](src/bin.ts) loads only the selected runner. Invalid commands, options from another mode, configuration errors, and boot failures exit nonzero.

## Entry modes

| Command | Purpose |
|---|---|
| `shres --profile <name>` | Boot the named profile under `$SHRES_HOME/profiles/<name>`. |
| `shres --profile headless "job"` | Run one fresh persisted session, print the final answer, and exit. |
| `shres web` | Alias of `--profile web`. |
| `shres plugin --profile <name> install-plugin <spec> [--yes]` | Preview and confirm a Shres bundle installation; activation requires a restart. |
| `shres plugin --profile <name> remove-plugin <name> [--yes]` | Confirm removal of a profile-managed plugin; loaded code remains until restart. |
| `shres plugin --profile <name> <pnpm args>` | Expert pnpm forwarding, without the managed commands' confirmation guarantees. |
| `shres skill add <directory>` / `list` / `remove <name>` | Manage local skill copies in the Shres-specific installed directory. |
| `shres plugin --profile <name> enable-edition <edition>` | Select a declared profile edition: mark it `autoProvision` and provision its packages through pnpm. |
| `shres models` / `shres providers` | List, set, discover, and add models using the same `$SHRES_HOME` settings and credentials as Settings → Models. |

The invoking directory is the default workspace root. The `web` and `headless` profiles auto-initialize on first use from shipped templates; any other profile must be created through `shres plugin`.

For an external browser-automation runtime, follow the [BrowserSkill setup tutorial](../../docs/cookbook/browserskill.md). Installing its skill does not install the CLI or browser extension.

## App arguments

The launcher parses only its own flags and hands everything after them to the booted profile, where any injected app plugin may parse the shared immutable snapshot ([`shres-cmdline`](../../packages/boot/cmdline/README.md)). Launcher flags therefore come first, and the first token the launcher does not recognize starts the app's arguments:

```sh
shres --profile web --port 8080       # --port belongs to the web app
shres --profile tui --resume <id>     # example, assuming the tui profile is installed; --resume belongs to the terminal app
shres --profile headless "run the tests"
shres --profile web --help            # the web app's flags, not the launcher's
shres --help                          # the launcher's own help
```

## Profiles

A profile directory holds a `package.json` (out-of-tree plugin dependencies plus the profile manifest `shres.profile` with its ordered `bundles` list) and a `cordis.patch.yml` (the user's own patch layer).

The tree composes over an empty root:
- each bundle's patch in `shres.profile.bundles` order
- then the profile's `cordis.patch.yml`, then the home-level `$SHRES_HOME/cordis.patch.yml`
- then `--patch` overlays

Bundles named in `shres.profile.bundles` resolve from the shres installation first (`@shres-code/shres-code-base`, `@shres-code/shres-code-web-app`, `@shres-code/shres-code-headless`), then from the profile's own `node_modules`, where pnpm installs out-of-tree plugins.

Use `--dump-default-config` and `--dump-config` to inspect the composed tree without booting it.

## Editions

A profile may declare an **edition inventory** under `shres.editions` in its `package.json` — a named set of npm specs and an `autoProvision` flag. New `web` and `headless` profiles ship:

```json
{ "shres": { "editions": { "shield": { "packages": ["@shrestech/shres-shield-plugin"], "autoProvision": true } } } }
```

Config declares the inventory; **enabling selects** among declared editions. Nothing auto-writes an edition onto an existing profile. `enable-edition <edition>` is the explicit selection: it sets that edition's `autoProvision` and provisions its packages through the same pnpm forwarder (then reconciles the bundle layers). An undeclared edition fails loud.

At profile boot, every edition with `autoProvision: true` has each declared package checked against the profile's `node_modules`; a missing package is installed once through the same forwarder, and a pnpm failure fails the boot loudly with the exact pnpm error — a missing paid payload is never silently skipped. An enabled Shield seat also installs npm `latest` into the boot profile when resolve is empty and `SHRES_SHIELD_MODULE` is unset. The shield seat resolves its paid payload from that same profile directory.

The [CLI behavior reference](reference/README.md) owns exact layer precedence, flags, shutdown behavior, deployment defaults, and source execution.

## Development

Production runs require built package and frontend artifacts. From the repository root, run `pnpm run build` separately, then use `pnpm shres <args...>` to run the TypeScript entry and forward every argument; the [source-execution reference](reference/README.md#source-execution) owns the module-resolution contract.
