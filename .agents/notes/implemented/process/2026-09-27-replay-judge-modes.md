# Agent Note: Replay judge modes

Status: implemented

## Problem

`hostReplayTrial({ judge: true })` always wrote `settings.yaml` selecting `scripted-fitting` and the overlay always disabled `judgment-laya`. A production calibration run therefore could not ask R's composed fitting engine.

## Decision

`judge` is `{ mode: 'off' }` (default, prepare-only), `{ mode: 'composition' }`, or `{ mode: 'fixture', fittingJudgePath, fittingJudgeConfig, engineId, judgmentEnabled }` with every fixture field required. Off disables Laya and inserts the non-fitting placeholder; the plugin asserts zero asks. Composition does not touch Laya, inserts no engines, and writes no settings; the plugin asserts the asked id equals dump-config `judgment-dispatch.defaultEngine`, `fittingFor` is defined, and registry `status().state` is `ready` (otherwise `UsageError('fitted engine <id> not ready: <state>')`, 0 asks, no install). Fixture disables Laya, inserts the given engine, and writes settings from the explicit `engineId` and enabled flag. When `extraOverlay` is present, `hostReplayRun` first dumps the baseline composition and refuses overlays that patch or insert composed judgment rows (`loadOverlayPatches`; `!!js` unevaluated).

## Alternatives considered

**Keep the boolean plus optional fixture path.** Omitted path still selected `scripted-fitting` and still disabled Laya, so production could not use the composed engine.

**Let `--extra-overlay` swap engines.** That is an accidental substitution of the composed judgment row. The dump-id guard covers named judgment rows only; it is not a sandbox.

**Read readiness from dispatcher internals.** The router already uses `ctx.judgment.selectedEngine` and `ctx.judgmentEngines.get(id).status()`. Those public reads are enough.

## Consequences

Prepare-only stays the default. Fixture tests keep the scripted engine by naming it. Composition runs use R as composed and refuse a not-ready Laya without creating `runtimes/laya-gateway`. Summaries record `judgeMode` and `engineId`.
