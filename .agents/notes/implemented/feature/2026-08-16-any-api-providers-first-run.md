# Agent Note: Any-API provider routes and a first-run model picker

Status: implemented

English | [中文](2026-08-16-any-api-providers-first-run.zh.md)

## Problem

The pi-ai adapter could already serve OpenAI-compatible and catalog providers, but the shipped base bundle left `llm-pi-ai` dormant and first-run onboarding offered only official DeepSeek. A user without `DEEPSEEK_API_KEY` either hit `MISSING_CREDENTIAL` or watched the SDK silently mount DeepSeek. There was no local-Ollama probe, no shipped Ollama Cloud / Grok / Kimi / Claude routes, and no TTY picker that wrote `agent-default-model` plus credentials.

## Decision

The base bundle composes a default `llm-pi-ai` route set: `ollama-local` (keyless `http://localhost:11434/v1` with `Authorization: Bearer ollama`), `ollama-cloud` (`https://ollama.com/v1`, `OLLAMA_API_KEY`, `:cloud` model ids), and catalog routes `openai`, `anthropic`, `xai` (`XAI_API_KEY`), `moonshotai` (`MOONSHOT_API_KEY`), `openrouter`, and `groq`. Named-but-unset keys fail `MISSING_CREDENTIAL`; the routes stay visible in the picker.

`@roos-code/roos-code-first-run-setup` owns first-run as one package. It reuses `discoverModels` for `GET {ollamaBaseURL}/models` with a configured timeout. Setup is required when the user layer of `agent-default-model` is empty and the current default cannot serve. Local Ollama is usable only while that probe succeeds. A TTY menu offers detected local models, the template routes, and a custom base URL, then writes the default and any typed key. A non-TTY process fails loud and names those configuration paths. Headless calls `ensureReady()` after the loader settles; the base bundle leaves `autoRunCli` false so Web never blocks on stdin.

Web onboarding no longer special-cases DeepSeek. Any keyed usable provider ends the step. Local Ollama is always composed and keyless, so it does not itself end the step; the card offers every incomplete keyed route plus `ollama-local`, and a successful pick writes `agent-default-model`.

The SDK server no longer auto-mounts `roos-llm-deepseek`. `initialize` reuses a pre-registered adapter and fails if the named provider has none. A DeepSeek default is used only when composition already registered that adapter and the matching credential is present.

### Ollama cloud model ids

Public library pages list `deepseek-v4-flash:cloud`, `deepseek-v4-flash:0731-cloud`, `deepseek-v4-pro:cloud`, and `deepseek-v4-pro:0813-cloud`. `ollama run deepseek-v4-flash:cloud` and `ollama launch … --model deepseek-v4-flash:0731-cloud` use those same API ids; the `:cloud` suffix is part of the model id, not a separate flag. The shipped catalog pins `deepseek-v4-flash:cloud` and `deepseek-v4-pro:cloud` (1M context, 32k max tokens) because `GET /models` does not disclose capacities. Other hosted names (`kimi-k3`, dated `-cloud` tags) exist in the public catalog and are not shipped as defaults.

## Alternatives considered

**Keep `llm-pi-ai` dormant and document hand-written settings.** That leaves first-run on DeepSeek alone and hides routes the picker must offer before any key exists.

**Auto-select local Ollama whenever `localhost:11434` answers.** That is a silent vendor default on any machine running Ollama. The probe only populates menu rows; the user still picks.

**Keep the SDK DeepSeek fallback when `DEEPSEEK_API_KEY` is set.** That still hides a vendor mount inside the server. Fail-loud plus composition is the single rule: the surrounding `cordis.yml` registers the adapter, and the key only makes an already-registered route usable.

**Split first-run into Service Definition / Provider / Consumer packages.** The picker, probe, and writes are one host-side flow; a split would add packages without an independent evolution axis.

## Consequences

A fresh Web or headless process can start on Ollama, Claude, Grok, Kimi, OpenAI, OpenRouter, Groq, or a custom base URL without editing YAML first. Unset named keys stay visible and fail `MISSING_CREDENTIAL`. SDK clients must compose the adapter they name. The snapshot harness has no first-run CLI transcript fixture; package tests pin the menu text instead.

## Testing

`llm-pi-ai` mock-server specs cover `GET /v1/models` and chat completions including a `:cloud` id, plus the keyless Bearer workaround. Key-gated e2e self-skips on `OLLAMA_API_KEY`, `XAI_API_KEY`, `MOONSHOT_API_KEY`, `ANTHROPIC_API_KEY`, and when local Ollama is unreachable. `first-run-setup` specs cover probe success/failure, readiness, the CLI transcript, and apply writes. `ui-settings-models` readiness and dialog specs cover any-route onboarding and the local-Ollama exception.
