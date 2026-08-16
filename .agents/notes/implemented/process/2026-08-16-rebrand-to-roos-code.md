# Agent Note: Rebrand to Roos Code

Status: implemented

## Problem

The repository shipped as DeepSeek Harness under the `@deepseek-ai/dsh-*` npm names, the `dsh` CLI, `$DSH_*` environment variables, and `~/.dsh`. That identity is a DeepSeek product name. A fork that will publish under a different org cannot keep those names: the scoped packages would squat `@deepseek-ai`, hook scripts and env contracts would stay tied to `DSH_*`, and user data would keep landing in `~/.dsh`. There are no external consumers yet, so a compatibility shim would only preserve a name the project is leaving.

## Decision

The product is Roos Code. One scripted mechanical rewrite (`scripts/rebrand.ts`, checked by `rebrand:check` in `hygiene`) updates every live reference together. There is no compatibility shim and no on-disk migration: backends reject old formats.

| Old | New |
|---|---|
| `@deepseek-ai/dsh-<x>` | `@roos-code/roos-code-<x>` |
| `@deepseek-ai/dsh` | `@roos-code/roos-code` (`bin` `dsh` → `roos`) |
| `@deepseek-ai/cordis` and the rest of the vendored family | `@roos-code/cordis` and the same suffixes |
| `@deepseek-ai/node-addon-landlock-run*` | `@roos-code/node-addon-landlock-run*` |
| `DSH_*` | `ROOS_*` |
| `~/.dsh` / `.dsh` | `~/.roos` / `.roos` |
| `dsh-v` / family id `'dsh'` | `roos-v` / `'roos'` |
| `DeepSeek Harness` | `Roos Code` |
| `github.com/deepseek-ai/deepseek-harness` and `github.com/deepseek-harness/deepseek-harness` | `github.com/roos-code/roos-code` |
| `deepseek-harness-sdk` / `deepseek_harness` / `deepseek-harness-runtime-bin` / `deepseek_harness_runtime` | `roos-code-sdk` / `roos_code` / `roos-code-runtime-bin` / `roos_code_runtime` |
| `.agents/skills/dsh-*` | `.agents/skills/roos-*` |

The rewrite does not touch the DeepSeek API contract (`DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, `https://api.deepseek.com`), provider route id `deepseek-official`, plugin ids `llm-deepseek` and `web-search-deepseek`, model ids, Cordis protocol tokens (`cordis.yml`, `cordis:` builtins, `Symbol.for('schemastery')`), the `cordis` agent-preset directory, `~/.agents`, root `LICENSE` (the original `Copyright (c) 2026 DeepSeek` stays), or frozen `.agents/notes/**`. Root `NOTICE` records that Roos Code is a derivative of DeepSeek Harness and lists `@roos-code/cordis`-family vendored provenance. `scripts/verify-no-legacy-brand.ts` rejects leftover `@deepseek-ai/dsh`, `DSH_[A-Z]`, `~/.dsh`, `deepseek-harness-sdk`, and `DeepSeek Harness` outside that keep-list.

`DSH_*` → `ROOS_*` is a breaking env contract for hook scripts and child processes that read `DSH_SESSION_ID`, `DSH_SESSION_JSONL`, `DSH_SHELL`, `DSH_HOME`, and the rest. There is no alias. The home directory is a fresh `~/.roos`; an existing `~/.dsh` is left untouched and is not read.

## Alternatives considered

**Keep `@deepseek-ai/dsh-*` and only change the public product name.** Rejected because publication under `@deepseek-ai` would squat that org, and the env/home/bin names would still say DeepSeek.

**Ship `DSH_*` aliases and copy or symlink `~/.dsh` into `~/.roos`.** Rejected: pre-release has no external consumers to migrate, aliases hide the break, and reading the old home would mix two products' credentials and session logs.

**Rename at pack time only.** Rejected because published names would disagree with the source tree and no local run could reproduce what was published.

**Hand-edit the ~3,300 files.** Rejected because a rebase or a missed regex site would desynchronize names; `scripts/rebrand.ts` owns the mapping, path renames, exact edits, and `--check`.

## Consequences

- Installing or importing `@deepseek-ai/dsh-*` no longer resolves this repository. Consumers take `@roos-code/roos-code-*` and the `roos` bin.
- Hook scripts and child environments that read `DSH_*` must switch to `ROOS_*` in the same change that upgrades.
- User data created after the rebrand lives under `~/.roos`. Operators who want old settings copy them by hand; the product does not.
- `scripts/rescope-vendor.ts` now maps upstream Cordis names into `@roos-code`, not `@deepseek-ai`. `pnpm run rescope-vendor:check` and `pnpm run rebrand:check` both run in `hygiene`.
- Snapshot fixtures that embed identity strings (`roos-code/<version>`, the `harness:source` section, CLI name `roos`) were rewritten with the same token map so keyless replay stays green without a re-record.
