# Agent Note: Demo bins require explicit config consent and refuse untrusted !!js

Status: implemented

English | [中文](2026-08-16-demo-bin-config-consent.zh.md)

## Problem

`dsh-acp-demo` treated a missing `--config` as `./cordis.yml` in the invoking directory. A checkout that plants that file can therefore run `!!js` expressions and relative plugin `name:` values (`./x.js`) with the operator's privileges as soon as the bin starts. `dsh-jsonrpc-agent` already required an explicit path, but both bins loaded the invoking directory's `.env` through unhardened `loadEnv`, so the same checkout could set `DEEPSEEK_BASE_URL`, `SSL_CERT_FILE`, `HOME`, or other bootstrap names before any plugin mounted.

Passing `--config` is the operator naming a file. That is consent to load the YAML. It is not consent to execute arbitrary JavaScript or to import a relative plugin from a directory the operator did not pre-approve.

## Decision

`dsh-acp-demo` with no `--config` uses this package's bundled composition path, derived from the resolver module URL, and never a CWD-relative `cordis.yml`. `dsh-jsonrpc-agent` still requires `$DSH_CORDIS_CONFIG` or positional `argv[2]` and still has no built-in fallback.

An explicit path — `--config`, `$DSH_CORDIS_CONFIG`, or argv — is scanned as raw YAML text for `!!js` and for a `name:` value that starts with `./` or `../`. A missing explicit file fails as not found. A file outside `$DSH_HOME` that contains either construct fails, and the diagnostic says to place the file under `$DSH_HOME` to pre-approve those constructs. A file under `$DSH_HOME` (the home itself or a descendant, after `realpath`) may contain them. A file with neither construct may live anywhere.

Both bins load environment files through `loadLayeredEnv`, which rejects bootstrap-only names before applying either the project or home `.env`. `dsh-acp-demo` still skips that load when `DSH_SNAPSHOT=replay`, and still runs `resolveConfigPath` after the consented path is chosen so replay can swap `cordis.yml` for sibling `cordis.snapshot.yml`.

The resolver lives in each demo package (`resolveDemoConfig.ts`). The packages do not depend on each other.

## Alternatives considered

**Keep the CWD default and print a warning.** A warning does not stop the process from evaluating `!!js` in a hostile `cordis.yml`. The default is the hole.

**Treat every explicit `--config` as full consent, including `!!js` outside `$DSH_HOME`.** Naming a file is consent to load it as configuration. `!!js` and a relative `name:` execute code, which needs a separate pre-approval: the file must sit under `$DSH_HOME`.

**Ban `!!js` and relative plugin names even under `$DSH_HOME`.** That would remove the documented way to pre-approve a trusted composition that uses those constructs. Home placement is the approval.

**Put the helper in `dsh-app-boot`.** The product CLI already has its own launch path. Sharing a demo-only consent rule would widen app-boot's job for two bins that can each own an 80-line helper.

## Consequences

`cd` into an untrusted checkout and run `dsh-acp-demo` with no flags no longer mounts that checkout's `cordis.yml`. Operators who want `!!js` or a relative plugin `name:` copy or write the file under `$DSH_HOME` first. First-party example configs that still pass `--config` to a `!!js` file outside `$DSH_HOME` fail the same check until they do the same. A hostile `.env` can no longer redirect `DEEPSEEK_BASE_URL` or rewrite `HOME` through these bins.

## Testing

Each demo package's `resolve-demo-config.spec.ts` pins the no-flag default, the required-path case, `!!js` and relative `name:` outside `$DSH_HOME`, approval under `$DSH_HOME`, a file with neither construct outside home, a missing explicit file, and symlink canonicalization.
