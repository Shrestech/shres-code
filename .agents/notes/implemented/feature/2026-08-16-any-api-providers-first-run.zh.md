# Agent Note: 任意 API 提供方路由与首次运行模型选择器

Status: implemented

[English](2026-08-16-any-api-providers-first-run.md) | 中文

## 问题

pi-ai 适配器已经能服务 OpenAI 兼容与目录提供方，但随附的基础组合让 `llm-pi-ai` 处于休眠，首次运行引导只提供官方 DeepSeek。没有 `DEEPSEEK_API_KEY` 的用户要么遇到 `MISSING_CREDENTIAL`，要么看到 SDK 静默挂载 DeepSeek。没有本机 Ollama 探测，没有随附的 Ollama Cloud / Grok / Kimi / Claude 路由，也没有把 `agent-default-model` 和凭据写进去的 TTY 选择器。

## 决策

基础组合提供一套默认 `llm-pi-ai` 路由：`ollama-local`（无需密钥的 `http://localhost:11434/v1`，带 `Authorization: Bearer ollama`）、`ollama-cloud`（`https://ollama.com/v1`、`OLLAMA_API_KEY`、`:cloud` 模型 id），以及目录路由 `openai`、`anthropic`、`xai`（`XAI_API_KEY`）、`moonshotai`（`MOONSHOT_API_KEY`）、`openrouter` 和 `groq`。已命名但尚未设置的密钥会以 `MISSING_CREDENTIAL` 失败；这些路由仍会出现在选择器中。

`@roos-code/roos-code-first-run-setup` 把首次运行放在一个包里。它复用 `discoverModels`，按配置的超时调用 `GET {ollamaBaseURL}/models`。当 `agent-default-model` 的用户层为空且当前默认值无法提供服务时，需要进入设置。本机 Ollama 仅在该探测成功时可用。TTY 菜单提供探测到的本机模型、模板路由和自定义基础 URL，然后写入默认值以及输入的密钥。非 TTY 进程会明确失败，并点名这些配置路径。headless 在 loader 就绪后调用 `ensureReady()`；基础组合将 `autoRunCli` 设为 false，避免 Web 在 stdin 上阻塞。

Web 引导不再特殊对待 DeepSeek。任何一个已配置密钥的可用提供方都会结束该步骤。本机 Ollama 始终被组合且无需密钥，因此它本身不会结束该步骤；卡片提供所有尚未填密钥的路由以及 `ollama-local`，成功选择后写入 `agent-default-model`。

SDK 服务器不再自动挂载 `roos-llm-deepseek`。`initialize` 复用预先注册的适配器，若点名的提供方没有适配器则失败。仅当组合已经注册该适配器且对应凭据存在时，才会使用 DeepSeek 默认值。

### Ollama 云端模型 id

公开库页面列出 `deepseek-v4-flash:cloud`、`deepseek-v4-flash:0731-cloud`、`deepseek-v4-pro:cloud` 和 `deepseek-v4-pro:0813-cloud`。`ollama run deepseek-v4-flash:cloud` 与 `ollama launch … --model deepseek-v4-flash:0731-cloud` 使用同样的 API id；`:cloud` 后缀是模型 id 的一部分，不是单独的标志。随附目录钉住 `deepseek-v4-flash:cloud` 和 `deepseek-v4-pro:cloud`（100 万上下文、3.2 万最大 token），因为 `GET /models` 不会披露容量。公开目录中还有其他托管名称（`kimi-k3`、带日期的 `-cloud` 标签），它们不是随附默认值。

## 考虑过的替代方案

**让 `llm-pi-ai` 继续休眠，并文档化手写 settings。** 这会把首次运行留在仅 DeepSeek，并在任何密钥存在之前隐藏选择器必须提供的路由。

**只要 `localhost:11434` 有应答就自动选择本机 Ollama。** 这是在任何运行 Ollama 的机器上静默默认某个厂商。探测只用于填充菜单行；仍由用户选择。

**在设置了 `DEEPSEEK_API_KEY` 时保留 SDK 的 DeepSeek 回退。** 这仍会在服务器内部隐藏一次厂商挂载。明确失败加上组合是唯一规则：外围 `cordis.yml` 注册适配器，密钥只让已经注册的路由变得可用。

**把首次运行拆成 Service Definition / Provider / Consumer 包。** 选择器、探测和写入是同一条主机侧流程；拆分会增加包，却没有独立演化的轴。

## 后果

全新的 Web 或 headless 进程可以先从 Ollama、Claude、Grok、Kimi、OpenAI、OpenRouter、Groq 或自定义基础 URL 开始，而不必先编辑 YAML。未设置的具名密钥仍然可见，并以 `MISSING_CREDENTIAL` 失败。SDK 客户端必须组合它所点名的适配器。快照工具没有首次运行 CLI 文本记录夹具；改由包测试钉住菜单文本。

## 测试

`llm-pi-ai` 的 mock-server 规格覆盖 `GET /v1/models`、包含 `:cloud` id 的聊天补全，以及无需密钥的 Bearer 变通。按密钥门控的 e2e 在缺少 `OLLAMA_API_KEY`、`XAI_API_KEY`、`MOONSHOT_API_KEY`、`ANTHROPIC_API_KEY` 或本机 Ollama 不可达时自行跳过。`first-run-setup` 规格覆盖探测成败、就绪判断、CLI 文本记录和应用写入。`ui-settings-models` 的就绪与对话框规格覆盖任意路由引导以及本机 Ollama 例外。
