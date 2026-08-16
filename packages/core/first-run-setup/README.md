# @roos-code/roos-code-first-run-setup

First-run model picker. `FirstRunSetup` provides `ctx.firstRunSetup`; it probes local Ollama, decides whether the current `agent-default-model` selection can already serve, and on a TTY prints a menu that writes that settings section plus any typed key through the credentials seam.

The plugin does not silently select a vendor. A composition default such as `deepseek-official` is used only when that route is already usable (typically `DEEPSEEK_API_KEY` is set). Otherwise a TTY shows detected local Ollama models, the shipped template routes (Ollama Cloud, OpenAI, Anthropic, xAI, Moonshot, OpenRouter, Groq, DeepSeek), and a custom base URL; a non-TTY process fails with an error that names those same configuration paths.

- `ctx.firstRunSetup.needsSetup()` is true when the user layer of `agent-default-model` is empty and the current default cannot serve.
- `ctx.firstRunSetup.detectLocalOllama()` calls `GET {ollamaBaseURL}/models` through pi-ai discovery, with `detectTimeoutMs`.
- `ctx.firstRunSetup.ensureReady(io?)` runs the CLI picker when setup is required. Headless calls this after the loader settles so adapter routes exist first.
- `autoRunCli` runs that picker during plugin apply. The base bundle leaves it false so the Web process never blocks on stdin.

Config fields `ollamaBaseURL`, `detectTimeoutMs`, and `autoRunCli` are the deployment-varying probe URL, timeout, and auto-run switch.

## Model Experience

Indirectly, through the `ModelSelection` and credentials it writes; request assembly and adapters own the model-visible request.

#### KV Cache effect

The picker runs before the first Agent is created, so it does not invalidate an established request prefix.

## Known Limitations and Deferred Work

- **The snapshot harness has no first-run CLI transcript fixture** — package tests pin the menu text and apply path; an assembled-application snapshot is not expressed yet.
- **Web onboarding probes local Ollama through `llm.discoverModels`** — a browser cannot reach `localhost:11434` itself.
