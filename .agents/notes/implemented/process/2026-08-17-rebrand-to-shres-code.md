# Agent Note: Rebrand to Shres Code

Status: implemented

## Problem

The repository ships as Roos Code under the `@roos-code/roos-code-*` npm names, the `roos` CLI, `$ROOS_*` environment variables, and `~/.roos`. That identity is a previous fork name. A fork that publishes under a different org cannot keep those names: the scoped packages would squat `@roos-code`, hook scripts and env contracts would stay tied to `ROOS_*`, and user data would keep landing in `~/.roos`. There are no external consumers yet, so a compatibility shim would only preserve a name the project is leaving.

## Decision

The product is Shres Code. This identity supersedes [Rebrand to Roos Code](./2026-08-16-rebrand-to-roos-code.md). One scripted mechanical rewrite (`scripts/rebrand.ts`, checked by `rebrand:check` in `hygiene`) updates every live reference together. There is no compatibility shim and no on-disk migration: backends reject old formats.

| Surface | From | To |
|---|---|---|
| Display | Roos Code | Shres Code |
| Slug / User-Agent | roos-code | shres-code |
| CLI / bin | roos | shres |
| npm | `@roos-code/roos-code-*` | `@shres-code/shres-code-*` |
| Vendored | `@roos-code/cordis` and the rest of the vendored family | `@shres-code/cordis` and the same suffixes |
| Manifest field | `"roos": { profile/bundle }` | `"shres": { profile/bundle }` |
| Env | `ROOS_*` | `SHRES_*` |
| Home | `~/.roos` | `~/.shres` |
| Release | family `'roos'`, tag `roos-v` | `'shres'`, `shres-v` |
| GitHub | `github.com/roos-code/roos-code` | `github.com/parthmstech/shres-code` |
| Python | `roos-code-sdk` / `roos_code` / `roos-code-runtime-bin` / `roos_code_runtime` | `shres-code-sdk` / `shres_code` / `shres-code-runtime-bin` / `shres_code_runtime` |
| Skills | `.agents/skills/roos-*` | `.agents/skills/shres-*` |

The rewrite does not touch the DeepSeek API contract (`DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, `https://api.deepseek.com`), Cordis protocol tokens (`cordis.yml`, `cordis:` builtins), root `LICENSE` (the original `Copyright (c) 2026 DeepSeek` stays), frozen `.agents/notes/archived/**`, the decision table in [Rebrand to Roos Code](./2026-08-16-rebrand-to-roos-code.md), or the find-strings in `scripts/rebrand.ts`. Live Agent Notes keep current package, env, home, and product names. `pnpm-lock.yaml` is regenerated, not token-edited. Root `NOTICE` records that Shres Code is a derivative of DeepSeek Harness and lists `@shres-code/cordis`-family vendored provenance. `scripts/verify-no-legacy-brand.ts` keep-lists LICENSE, NOTICE, archived notes, this note, the Roos rebrand note, the rebrand/rescope/zh-purge scripts, and `vendor/*/README.md` plus `vendor/*/LICENSE`.

`ROOS_*` → `SHRES_*` is a breaking env contract for hook scripts and child processes that read `ROOS_SESSION_ID`, `ROOS_SESSION_JSONL`, `ROOS_SHELL`, `ROOS_HOME`, and the rest. There is no alias. The home directory is a fresh `~/.shres`; an existing `~/.roos` is left untouched and is not read.

## Alternatives considered

**Change user-facing strings only and keep `@roos-code`, `ROOS_*`, and `~/.roos` internally.** Rejected because publication under `@roos-code` would squat that org, and the env/home/bin names would still say Roos.

**Keep publishing under `@roos-code`.** Rejected: this fork does not own that scope.

**Publish the GitHub analog `shres-code/shres-code`.** Rejected: this fork's origin is `parthmstech`; the destination is `parthmstech/shres-code`.

**Hand-edit thousands of files instead of retargeting `scripts/rebrand.ts`.** Rejected because a rebase or a missed regex site would desynchronize names; the rewrite script owns the mapping, path renames, exact edits, and `--check`.

**Ship `ROOS_*` aliases and migrate `~/.roos` into `~/.shres`.** Rejected: pre-release has no external consumers to migrate, aliases hide the break, and reading the old home would mix two products' credentials and session logs.

## Consequences

- Installing or importing `@roos-code/roos-code-*` no longer resolves this repository. Consumers take `@shres-code/shres-code-*` and the `shres` bin.
- Hook scripts and child environments that read `ROOS_*` must switch to `SHRES_*` in the same change that upgrades.
- User data lives under `~/.shres`. Operators who want old settings copy them by hand; the product does not read `~/.roos`.
- `scripts/rescope-vendor.ts` maps upstream Cordis names into `@shres-code`, not `@roos-code`. `pnpm run rescope-vendor:check` and `pnpm run rebrand:check` both run in `hygiene`.
- Snapshot fixtures that embed identity strings (`shres-code/<version>`, the `harness:source` section, CLI name `shres`) are rewritten with the same token map so keyless replay stays green without a re-record.
