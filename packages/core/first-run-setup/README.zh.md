# @roos-code/roos-code-first-run-setup

[English](README.md) | 中文

首次运行模型选择器。`FirstRunSetup` 提供 `ctx.firstRunSetup`；它探测本机 Ollama，判断当前 `agent-default-model` 选择是否已经能提供服务，并在 TTY 上打印菜单，把该设置分节以及输入的密钥写入 credentials 能力。

该插件不会静默选定某个厂商。组合配置中的默认值（例如 `deepseek-official`）仅在该路由已经可用时使用（通常是已设置 `DEEPSEEK_API_KEY`）。否则 TTY 会列出探测到的本机 Ollama 模型、随附的模板路由（Ollama Cloud、OpenAI、Anthropic、xAI、Moonshot、OpenRouter、Groq、DeepSeek）以及自定义基础 URL；非 TTY 进程会失败，并在错误中点名这些配置路径。

- 当 `agent-default-model` 的用户层为空且当前默认值无法提供服务时，`ctx.firstRunSetup.needsSetup()` 为 true。
- `ctx.firstRunSetup.detectLocalOllama()` 通过 pi-ai 发现调用 `GET {ollamaBaseURL}/models`，超时为 `detectTimeoutMs`。
- `ctx.firstRunSetup.ensureReady(io?)` 在需要设置时运行 CLI 选择器。headless 在 loader 就绪后再调用，以便适配器路由已经存在。
- `autoRunCli` 在插件 apply 期间运行该选择器。基础组合将其设为 false，避免 Web 进程在 stdin 上阻塞。

配置字段 `ollamaBaseURL`、`detectTimeoutMs` 和 `autoRunCli` 分别是随部署变化的探测 URL、超时和自动运行开关。

## 模型体验

通过它写入的 `ModelSelection` 和凭据间接影响；模型可见请求由请求组装与适配器负责。

#### KV Cache 影响

选择器在第一个 Agent 创建之前运行，因此不会使已建立的请求前缀失效。

## 已知限制与暂缓事项

- **快照工具还没有首次运行 CLI 文本记录夹具** — 包测试钉住菜单文本和应用路径；组装后的应用快照尚未表达。
- **Web 引导通过 `llm.discoverModels` 探测本机 Ollama** — 浏览器自身无法访问 `localhost:11434`。
