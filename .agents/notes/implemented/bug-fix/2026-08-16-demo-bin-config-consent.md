# Agent Note: Demo bins require explicit config consent and refuse untrusted !!js

Status: implemented

English | [中文](2026-08-16-demo-bin-config-consent.zh.md)

## Problem

`dsh-acp-demo` treated a missing `--config` as `./cordis.yml` in the invoking directory. A checkout that plants that file can therefore run `!!js` expressions and relative plugin `name:` values (`./x.js`) with the operator's privileges as soon as the bin starts. `dsh-jsonrpc-agent` already required an explicit path, but both bins loaded the invoking directory's `.env` through unhardened `loadEnv`, so the same checkout could set `DEEPSEEK_BASE_URL`, `SSL_CERT_FILE`, `HOME`, or other bootstrap names before any plugin mounted.

Passing `--config` is the operator naming a file. That is consent to load the YAML. It is not consent to execute arbitrary JavaScript or to import a relative plugin from a directory the operator did not pre-approve.

## Decision

Both bins require an explicit config path and never load a CWD `cordis.yml` by default. `dsh-acp-demo` takes `--config` / `-c`. `dsh-jsonrpc-agent` takes `$DSH_CORDIS_CONFIG` or positional `argv[2]`. A missing path prints usage and exits; a named path that does not exist fails as not found.

An explicit path is scanned as raw YAML text for `!!js` and for a `name:` value that starts with `./` or `../` (optional space before `:`, optional `!!tag` such as `!!str` before the path). A file that contains either construct is allowed when its canonical path is `$DSH_HOME` or a descendant, or when it sits inside a first-party tree discovered by walking from the module URL and from `process.execPath` (never from the invoking directory): this harness source checkout (`pnpm-workspace.yaml` plus both demo packages), a packaged runtime that ships `runtime/cordis.yml` or `cordis.yml` next to `node/`, or the installed demo package directory. Walking the real exe is required for the Python SDK's pkg `--sea` carrier, whose `import.meta.url` is `file:///snapshot/...` while on-disk `runtime/cordis.yml` sits next to `runtime/dsh-jsonrpc-agent-pkg-*`. Any other location fails, and the diagnostic says to place the file under `$DSH_HOME` to pre-approve those constructs. A file with neither construct may live anywhere.

The scan is a best-effort raw-text filter. It does not parse includes or every YAML encoding. The hard guarantee is that these bins never load a CWD `cordis.yml` without an explicit path.

Both bins load environment files through `loadLayeredEnv`, which rejects bootstrap-only names before applying either the project or home `.env`. `dsh-acp-demo` still skips that load when `DSH_SNAPSHOT=replay`, and still runs `resolveConfigPath` after the consented path is chosen so replay can swap `cordis.yml` for sibling `cordis.snapshot.yml`.

The resolver lives in each demo package (`resolveDemoConfig.ts`). The packages do not depend on each other.

## Alternatives considered

**Keep the CWD default and print a warning.** A warning does not stop the process from evaluating `!!js` in a hostile `cordis.yml`. The default is the hole.

**Treat every explicit `--config` as full consent, including `!!js` in a hostile checkout.** Naming a file is consent to load it as configuration. `!!js` and a relative `name:` execute code. First-party leaves and the packaged `runtime/cordis.yml` are approved by location; a random checkout is not.

**Refuse every `!!js` file outside `$DSH_HOME`.** That breaks `pnpm demo:acp`, the snapshot suites, and the Python SDK's bundled `runtime/cordis.yml`. Those files are first-party or shipped, not a hostile CWD default.

**Ship an in-package ACP `cordis.yml` as the no-flag default.** The security property is "never CWD default", not "always boot something". A required `--config` matches the JSON-RPC bin and does not invent a second composition.

**Point `$DSH_HOME` at `examples/` so first-party leaves pass the home check.** That relocates skills, settings, and the home `.env`. Location allow-lists on the bin's install tree keep home as the user data root.

**Put the helper in `dsh-app-boot`.** The product CLI already has its own launch path. Sharing a demo-only consent rule would widen app-boot's job for two bins that can each own the helper.

## Consequences

`cd` into an untrusted checkout and run `dsh-acp-demo` with no flags no longer mounts that checkout's `cordis.yml`; the bin requires `--config`. The same checkout's explicit `./cordis.yml` with `!!js` or a relative plugin `name:` is still refused unless the file is copied under `$DSH_HOME`. `demo:acp`, snapshot leaves under `examples/`, and the packaged Python runtime `runtime/cordis.yml` keep working because they sit in a first-party or packaged tree. A hostile `.env` can no longer redirect `DEEPSEEK_BASE_URL` or rewrite `HOME` through these bins.

## Testing

Each demo package's `resolve-demo-config.spec.ts` pins the required-path case against a CWD `cordis.yml`, the first-party `examples/*/cordis.yml` leaf, a harness-checkout fixture, a packaged-runtime fixture, a pkg-snapshot module URL plus on-disk exe `runtime/cordis.yml`, a CWD `runtime/cordis.yml` that must stay refused, `!!js` and relative `name:` (including `name :` and `!!str`) outside every approved location, approval under `$DSH_HOME`, a file with neither construct outside home, a missing explicit file, and symlink canonicalization.
