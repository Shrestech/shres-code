# Agent Note: Speech lifecycle, projection dispatch, and search-fence hardening

Status: implemented

## Problem

A read-only swarm review of the speech seam, session projection, and fs-search surfaces found four defect clusters, all in bug classes `docs/defensive-patterns.md` already codifies:

- **Kokoro load lock could deadlock the process.** `withTransformersCacheDir` awaited the `@huggingface/transformers` import after acquiring the module-global cache-dir lock but before its `try/finally`; a rejecting import (e.g. onnxruntime-node failing to load) never released the lock, so every later load hung silently.
- **`allowDownload: false` did not prevent downloads** in either local provider. The flag gated only `available()`'s warm-cache heuristic, and the loaders never told transformers to stay offline, so a stray file in the cache dir turned a promised refusal into a real Hugging Face download.
- **Mic/playback lifecycle races in ui-speech.** An uncancelled `getUserMedia` await kept the microphone live after unmount and a second click orphaned the first stream; `finish()` could fill and submit a departed session's composer after a session switch; a rejected `play()` tore down its replacement's element; one transient `status()` failure disabled speech until reload.
- **Dispatch and fence gaps.** `session-projection`'s eager `drive` ran unit folds and change listeners uncontained, so one throw starved every later unit of a committed event permanently (cells are never rebuilt). `tool-fs-search`'s fence compared lexical paths (a workspace symlink pointing outside passed) and rejected only credential files named as the search root — a directory search returned `*.credentials.yaml` contents that `read` refuses with `FS_SANDBOX_DENIED`.

## Decision

- `speech-kokoro`: the import moved inside the lock's `try`, whose `finally` always releases; the helper became `withTransformersEnv(importModule, cacheDir, allowDownload, work)` and additionally pins `env.allowRemoteModels = false` when the request forbids download, restoring both env values afterward. The import is injectable (`KokoroLoadRequest.importTransformers`) so the lock release is testable keyless.
- Both providers: `KokoroLoadRequest`/`WhisperLoadRequest` carry required `allowDownload`, threaded from config through `ensureEngine`; Whisper passes `local_files_only: !allowDownload` to `pipeline()`. A false-positive warm cache now fails loud at load instead of downloading.
- `ui-speech`: `MicButton` has a `mounted` ref — a `getUserMedia` resolving after unmount stops its tracks immediately, and `finish()` returns before touching `inputActions` when unmounted — plus a `starting` state that disables the button while the permission prompt pends. `playback` stops only when the rejecting/ending element is still `current`, so an interrupted play never tears down its replacement. The status probe re-runs on every `connection/reset`, matching sibling plugins.
- `session-projection`: `drive` contains each unit fold and each listener call (`contain()`, modeled on the telemetry coordinator) and warns with unit key and event seq; a failure skips that unit for that event only, and the cell commits state only after view/schema validation succeeds.
- `tool-fs-search`: search roots canonicalize through the deepest existing ancestor (`realpathSync.native`) before credential-name and workspace-containment checks, and every spawned ripgrep carries `--iglob=!*.credentials.yaml` before the tool argv, so no directory walk emits credential contents or paths.

## Alternatives considered

- **Tightening `cacheIsWarm` instead of loader enforcement** — rejected: the heuristic is a cheap availability probe; the repo rule is to enforce a decision in the operation that makes it, and only the loader can actually refuse a download.
- **Post-filtering search results for credential paths** — rejected: ripgrep would still read the files, and the blacklist glob rides before the tool's `--` terminator so it cannot be demoted to a search path; ripgrep's blacklist also overrides any model-chosen include glob.
- **Consulting fs-sandbox's `denyReadPaths` in search** — deferred: that list is fs-sandbox's private config, not a shared policy surface (`SandboxPolicyService` exposes mode/root/network only); the carve-out is documented in the package README's Known Limitations.
- **Failing the session append on a projection throw** — rejected: containment isolates the offender; the event is already committed, so the append path must stay alive and the hole stays confined to the throwing unit.
- **Keeping `MicButton`'s re-entry early-return covered by a test** — the `starting` disabled state is the mechanism and is test-pinned; the guard is unreachable through the only caller (React flushes discrete clicks) and carries a justified `v8 ignore`.

## Consequences

A warm-but-incomplete provider cache turns a previously silent download into a loud `SPEECH_PROVIDER_ERROR`; speech controls recover from transient probe failure on reconnect instead of staying disabled until reload. The speech feature decision in [speech I/O for the web client](../feature/2026-08-19-speech-io-web.md) is unchanged — this note owns only the defect repairs. The `denyReadPaths` carve-out is documented in the tool-fs-search README's Known Limitations; the pre-existing `speech-whisper/src/wav.ts` coverage gaps remain open.
