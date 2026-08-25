# Agent Note: Five-arm bench ladder and forensics metrics

Status: implemented

## Problem

The W0 benchmark suite started with two arms (`off`/`on`) that toggled only jspace. After session-query shipped as a default-on plugin in the headless composition (commit 82aa91854e), a pure jspace toggle no longer produced a clean control — the `off` arm still had session-query tools mounted and contributing to token usage. The evaluation plan ([proposed eval note](../../proposed/testing/2026-08-25-w0-harness-eval-arms-and-decision-rules.md)) required isolating jspace from session-query, measuring each independently and in combination, and adding evidence-grade verification as a contrast. The existing TrialMetrics lacked forensics fields for checkpoint quality, note-spam refusals, and session-query usage.

## Decision

The bench ladder expands from two arms to five, each realized as a `--patch` overlay applied to the shipped headless composition. The overlay mechanism combines jspace settings with `disabled: true` entries for plugin ids, leveraging the Cordis Loader's entry-level disable. The five arms are:

- `off`: jspace disabled, session-query excluded (plugin ids `session-query-sqlite` and `tool-session-query` set to `disabled: true`).
- `on`: jspace available, session-query excluded.
- `sq-only`: session-query mounted, jspace disabled.
- `on-sq`: both jspace and session-query (the shipped default composition).
- `on-sq-verified`: `on-sq` plus `verifierTools: ['bash']` and `requireVerifiedEvidence: true`.

The `bash` tool name was confirmed by searching the headless composition's shell plugin registrations.

The arm-integrity audit extends to check that arms excluding session-query show zero session-query `tool/call` events in session logs, alongside the existing zero-jspace-events check for jspace-off arms.

Eight forensics metric fields were added to TrialMetrics: `tokensIncludingDescendants` (null — descendant sessions not observable in v1), `costIncludingDescendants` (null — same reason), `danglingCard` (boolean; null for jspace-off arms), `verifiedCheckpointShare` (fraction; null when no checkpoints), `coverageRefusalThenPad` (count of checkpoint-refusal → immediate retry-success sequences), `noopNoteRefusals` (JSPACE_NOTE_NOOP count), `noteCapRefusals` (note-cap denial count), and `sessionQueryCalls` (session-query tool call count; null for arms excluding the consumer). The session-query tools counted are `session_search`, `session_event_search`, `session_event_read`, `session_event_trace`, and `session_trace`.

The task catalog expanded from 7 to 15 tasks: 5 long, 3 short, 2 adversarial, 5 chain.

The demo generator and report builder handle all five arms and all new metrics.

## Alternatives considered

**CLI `--exclude` flags for plugin exclusion.** The harness CLI does not support `--exclude` for composition entries. The `--patch` mechanism with `disabled: true` achieves the same result without harness changes and is already part of the Cordis Loader's documented behavior.

**Separate composition YAML files per arm.** This would have required maintaining parallel copies of the full headless composition. The overlay approach is more maintainable and declaratively composable.

**Recording `tokensIncludingDescendants` from parent session metadata.** The runner locates only the top-level `delegationDepth: 0` session; child sessions under the same persistence root are not guaranteed discoverable without a recursive walk. The field is recorded as null with schema JSDoc explaining why, keeping the schema ready for when descendant session enumeration becomes available.

The runner generalizes beyond DeepSeek with `--api-key-env <VAR|none>` (default `DEEPSEEK_API_KEY`) and `--tier-patch <path>`. The credential gate requires `env[VAR]` non-empty unless the value is `none` (keyless tier). A tier patch is an experiment-level `--patch` overlay that swaps the LLM adapter; the shres CLI accepts repeated `--patch` flags (confirmed: `apps/cli/src/args.ts` collects them with a repeatable option and the boot flattens all layers), so the arm overlay and tier overlay are passed as two `--patch` arguments to each spawn. `run.json` records the env var name in `apiKeyEnv` and the tier patch file path + SHA-256 hex in `tierPatch` (null when unused). When `--api-key-env` is not `DEEPSEEK_API_KEY`, `--base-url` defaults to null instead of falling back to `DEEPSEEK_BASE_URL`.

Two ready tier overlays exist under `bench/tiers/`: `zai.patch.yml` (disables `llm-deepseek`, inserts `llm-pi-ai` with a `zai` route using `apiKeyEnv: ZAI_API_KEY`, `baseURL: https://api.z.ai/api/paas/v4/`, and model `glm-5.3` with `contextWindow: 200000`) and `ollama-deepseek.patch.yml` (disables `llm-deepseek`, inserts `llm-pi-ai` with a keyless `ollama` route at `http://127.0.0.1:11434/v1` and placeholder model `deepseek-r1:32b`). Each overlay mirrors the plugin-entry shape of the headless composition's documented `llm-pi-ai` swap.

## Consequences

The clean control (`off`) now excludes both jspace and session-query, producing session logs with zero intervention events. The five-arm ladder enables pairwise contrasts: jspace alone vs session-query alone, combined vs isolated, and verified vs unverified evidence. The forensics metrics surface checkpoint quality and note-spam patterns that the pass/fail metric alone cannot distinguish.

Two TrialMetrics fields (`tokensIncludingDescendants`, `costIncludingDescendants`) are permanently null in v1 because the runner cannot enumerate descendant sessions. The schema carries the fields so future runner versions can populate them without a format version bump.

The `disabled: true` overlay mechanism depends on the Cordis Loader's entry-level disable remaining stable. If the Loader changes this behavior, the arm overlays need corresponding updates.

The tier mechanism depends on the shres CLI's repeatable `--patch` semantics: a CLI change that limits `--patch` to a single value would require the runner to merge the tier overlay into each arm overlay at write time instead.
