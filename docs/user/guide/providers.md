# Configure models

English | [中文](providers.zh.md)

This guide assumes you started the Web UI through the [root README](../../../README.md#run), or `roos --profile headless` on a TTY. Model changes take effect on the next request without restarting the server.

First run with no usable default opens a picker instead of silently choosing a vendor. Headless prints detected local Ollama models, the shipped template routes, and a custom base URL; Web shows the same routes on the onboarding card. A non-TTY process with no usable default fails and names those configuration paths.

## Configure a shipped provider

Open **Settings → Models**. The page lists the composed routes: DeepSeek, local Ollama, Ollama Cloud, OpenAI, Anthropic (Claude), xAI (Grok), Moonshot (Kimi), OpenRouter, and Groq.

![The Models page: the DeepSeek card, with Add provider and Add a custom provider below it](providers-models-page.png)

Each keyed card exposes one API-key field; enter the key and save it. Named-but-unset keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `MOONSHOT_API_KEY`, `OLLAMA_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `DEEPSEEK_API_KEY`) fail a request with `MISSING_CREDENTIAL` until stored.

Keys are write-only. The page receives a redacted descriptor after saving, never the literal secret. The key is stored in `$ROOS_HOME/.credentials.yaml`, while settings retain only its credential reference.

### Local Ollama

The `ollama-local` route talks to `http://localhost:11434/v1` and needs no API key. First run probes `GET /v1/models` and offers whatever that listing returns. The CLI id you pass to `ollama run` is the same id the API accepts.

### Ollama Cloud

The `ollama-cloud` route talks to `https://ollama.com/v1` with `OLLAMA_API_KEY`. Cloud model ids carry a `:cloud` suffix; the shipped catalog includes `deepseek-v4-flash:cloud` and `deepseek-v4-pro:cloud`. Those spellings match `ollama run deepseek-v4-flash:cloud`. Context window and max tokens are pinned on the route because `GET /models` does not disclose them.

### Claude, Grok, and Kimi

Anthropic, xAI, and Moonshot are catalog routes: pick the card, enter `ANTHROPIC_API_KEY`, `XAI_API_KEY`, or `MOONSHOT_API_KEY`, and save. The installed catalog supplies the endpoint, protocol, and model list. OpenAI, OpenRouter, and Groq work the same way.

Providers with native authentication need their native credentials instead. Bedrock, Vertex, Azure, and Codex use AWS credentials and a region, an ADC project, an `api-version`, and OAuth respectively; filling only the API-key field does not configure them.

## Add a custom provider

Choose **Add a custom provider** for a company gateway, self-hosted server, or provider absent from the installed catalog. Supply a lowercase Provider ID, base URL, API protocol, credential, and at least one model.

![The custom provider form: Provider ID, display name, base URL, API protocol, and API key](providers-custom-form.png)

The Provider ID is permanent because requests, saved sessions, model defaults, and credential references use it. To rename a provider, add a new provider and delete the old one. The display name, base URL, protocol, credential, and models remain editable.

Under **Model catalog**, choose **Fetch available models** to query the base URL and credential currently shown in the form. Selecting candidates updates the draft; the provider is not stored until you save. Catalog providers use their installed catalog without a network request.

### Image input

A model you enter by hand is treated as text-only until it says otherwise, because nothing can ask an endpoint which modalities it accepts. Attaching an image to such a model is refused before it is sent, naming the model.

A vision model on a custom provider therefore needs one line. The form has no field for it; add `input` to the model in `$ROOS_HOME/settings.yaml`:

```yaml
llm-pi-ai:
  providers:
    my-gateway:
      apiKeyEnv: GATEWAY_API_KEY
      api: openai-completions
      baseURL: https://gateway.example/v1
      models:
        - id: legacy-chat
        - id: vision-preview
          input: [text, image]
```

`input` accepts `text` and `image`, and applies to that model alone, so one route can serve both kinds. Omitting it — or writing an empty list, which means the same thing — keeps whatever the installed catalog records for that model, and falls back to the route's `defaultInput` for a model the catalog does not describe.

If every model you entered by hand takes images, set the fallback once on the route instead of on each of them:

```yaml
llm-pi-ai:
  providers:
    vision-gateway:
      apiKeyEnv: GATEWAY_API_KEY
      api: openai-completions
      baseURL: https://vision.example/v1
      defaultInput: [text, image]
      models:
        - id: first-model
        - id: second-model
```

`defaultInput` is a fallback, not an override, and defaults to `[text]`: on a catalog provider it answers only for models the catalog does not describe, so it never removes images from a catalog model that has them. Narrow one of those with that model's own `input`. A catalog provider has no `models` list to put it in, so write it under `modelOverrides`, keyed by model id:

```yaml
llm-pi-ai:
  providers:
    anthropic:
      modelOverrides:
        claude-sonnet-4-5:
          input: [text]
```

Every list must name at least one modality except a model's own, where an empty list means the same as omitting it. An unknown modality is refused wherever it is written.

Both fields state a claim about your endpoint rather than checking it. A model that declares images its endpoint does not serve is not caught here; the provider rejects the request instead.

## Select a model

Configured providers appear in the model picker. Selecting a model also makes it the default for new sessions. A session that has already sent a request retains the model recorded in its own log.

If a saved default names a provider that was deleted, the composer displays **Select model** and blocks input until another model is selected.

## Troubleshooting

- **`MISSING_CREDENTIAL`** — Store the provider key through the Models page or supply the referenced environment variable.
- **First-run picker on every headless run** — No user-saved `agent-default-model` exists and the composition default cannot serve. Pick a route, export a key, or write the section in `$ROOS_HOME/settings.yaml`.
- **Local Ollama is missing from the picker** — `GET http://localhost:11434/v1/models` did not answer. Start Ollama and retry; the shipped route still appears on the Models page.
- **`UNKNOWN_MODEL`** — Select a configured model or add the missing model to the custom provider.
- **Fetching available models returns 401** — Check the key. Model discovery calls the OpenAI-compatible `GET /models` endpoint; enter models manually for endpoints that do not provide it.
- **An image is refused before sending** — The model declares no image modality. Give a custom provider's model `input: [text, image]`; DeepSeek's own chat-completions route is text-only and cannot be configured otherwise.
- **The provider rejects a request carrying an image** — The model declares images its endpoint does not actually serve. Remove `image` from whichever list granted it — the model's `input`, or the route's `defaultInput` — then start a new session: the attached image stays in the session log, so the same request repeats until the session moves off it.

## Advanced configuration

The generated [plugin configuration catalog](../../config-catalog.md) lists every supported field and default. The [`roos-llm-pi-ai`](../../../packages/llm/llm-pi-ai/README.md) and [`roos-llm-deepseek`](../../../packages/llm/llm-deepseek/README.md) references own direct `settings.yaml` configuration, catalog resolution, reasoning controls, credentials, and adapter errors. The first-run picker contract lives in [`roos-first-run-setup`](../../../packages/core/first-run-setup/README.md). The [CLI models guide](./models.md) owns `roos models` and `roos providers`.
