# 配置模型

[English](providers.md) | 中文

本指南假定你已按照[根 README](../../../README.md#run)启动 Web UI，或在 TTY 上运行 `roos --profile headless`。模型变更会在下一次请求时生效，不需要重启服务器。

首次运行且没有可用默认值时，会打开选择器，而不会静默选定某个厂商。headless 会打印探测到的本机 Ollama 模型、随附的模板路由和自定义基础 URL；Web 在引导卡片上提供同样的路由。非 TTY 进程在没有可用默认值时会失败，并点名这些配置路径。

## 配置随附提供方

打开**设置 → 模型**。页面列出组合中的路由：DeepSeek、本机 Ollama、Ollama Cloud、OpenAI、Anthropic（Claude）、xAI（Grok）、Moonshot（Kimi）、OpenRouter 和 Groq。

![模型页：DeepSeek 卡片，以及添加提供方与添加自定义提供方两个入口](providers-models-page.zh.png)

每个需要密钥的卡片提供一个 API 密钥字段；输入密钥并保存。已命名但尚未设置的密钥（`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`XAI_API_KEY`、`MOONSHOT_API_KEY`、`OLLAMA_API_KEY`、`OPENROUTER_API_KEY`、`GROQ_API_KEY`、`DEEPSEEK_API_KEY`）在存储之前会让请求以 `MISSING_CREDENTIAL` 失败。

密钥是只写的。保存后，页面只会收到脱敏描述符，永远不会收到明文密钥。密钥存储在 `$ROOS_HOME/.credentials.yaml` 中，settings 只保留它的凭据引用。

### 本机 Ollama

`ollama-local` 路由访问 `http://localhost:11434/v1`，不需要 API 密钥。首次运行会探测 `GET /v1/models`，并列出该接口返回的模型。传给 `ollama run` 的 CLI id 与 API 接受的 id 相同。

### Ollama Cloud

`ollama-cloud` 路由使用 `OLLAMA_API_KEY` 访问 `https://ollama.com/v1`。云端模型 id 带 `:cloud` 后缀；随附目录包含 `deepseek-v4-flash:cloud` 和 `deepseek-v4-pro:cloud`。这些拼写与 `ollama run deepseek-v4-flash:cloud` 一致。上下文窗口和最大输出 token 钉在路由上，因为 `GET /models` 不会披露它们。

### Claude、Grok 和 Kimi

Anthropic、xAI 和 Moonshot 是目录路由：打开对应卡片，分别填入 `ANTHROPIC_API_KEY`、`XAI_API_KEY` 或 `MOONSHOT_API_KEY` 并保存。已安装目录提供端点、协议和模型列表。OpenAI、OpenRouter 和 Groq 的用法相同。

使用原生认证的提供方需要各自的原生凭据。Bedrock、Vertex、Azure 和 Codex 分别使用 AWS 凭据与区域、ADC 项目、`api-version` 和 OAuth；只填写 API 密钥字段无法完成配置。

## 添加自定义提供方

对于公司网关、自建服务器或已安装目录中不存在的提供方，选择**添加自定义提供方**。提供小写 Provider ID、基础 URL、API 协议、凭据和至少一个模型。

![自定义提供方表单：Provider ID、显示名称、API 地址、API 协议、API 密钥](providers-custom-form.zh.png)

Provider ID 是永久的，因为请求、已保存会话、模型默认值和凭据引用都会使用它。如需重命名提供方，请添加新提供方并删除旧提供方。显示名称、基础 URL、协议、凭据和模型仍可编辑。

在**模型目录**中选择**获取可用模型**，可查询表单当前显示的基础 URL 和凭据。选择候选项只会更新草稿；保存前不会存储提供方。目录提供方使用已安装目录，不发起网络请求。

### 图片输入

手动输入的模型在自己声明之前一律按纯文本对待，因为没有任何环节能去询问端点接受哪些模态。给这类模型附加图片，会在发送前就被拒绝，并点名该模型。

因此自定义提供方下的视觉模型需要加一行。表单没有对应字段；请在 `$ROOS_HOME/settings.yaml` 中给该模型加上 `input`：

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

`input` 接受 `text` 和 `image`，且只作用于该模型，因此一条路由可以同时服务两类模型。省略它——或写成空列表，两者同义——则保留已安装目录为该模型记录的模态；目录未描述的模型则回退到该路由的 `defaultInput`。

如果你手动录入的模型全都接受图片，可以在路由上设置一次回退值，不必逐个模型写：

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

`defaultInput` 是回退值而不是覆盖值，默认为 `[text]`：在目录提供方上，它只为目录未描述的模型作答，因此绝不会把目录中本就具备图片能力的模型的该能力去掉。要收窄这类模型，请用它自己的 `input`。目录提供方没有可供填写的 `models` 列表，因此写在 `modelOverrides` 下，以模型 id 为键：

```yaml
llm-pi-ai:
  providers:
    anthropic:
      modelOverrides:
        claude-sonnet-4-5:
          input: [text]
```

除模型自身的列表外，每个列表都至少要写一项模态；模型自身的空列表与省略它同义。未知模态在任何位置写入都会被拒绝。

这两个字段都是对你端点的断言，而不是对它的检查。声明了端点并不提供的图片能力的模型不会在这里被拦下，改由提供方拒绝该请求。

## 选择模型

已配置的提供方会出现在模型选择器中。选择模型也会将其设为新会话的默认值。已发送过请求的会话会保留自身日志中记录的模型。

如果已保存默认值指向已删除的提供方，输入框会显示**选择模型**，并在选择其他模型前阻止输入。

## 排错

- **`MISSING_CREDENTIAL`**：通过模型页存储提供方密钥，或提供被引用的环境变量。
- **每次 headless 运行都出现首次运行选择器**：没有用户保存的 `agent-default-model`，且组合默认值无法提供服务。请选择一条路由、导出密钥，或在 `$ROOS_HOME/settings.yaml` 中写入该分节。
- **选择器里没有本机 Ollama**：`GET http://localhost:11434/v1/models` 没有应答。请启动 Ollama 后重试；随附路由仍会出现在模型页上。
- **`UNKNOWN_MODEL`**：选择已配置的模型，或向自定义提供方添加缺失的模型。
- **获取可用模型返回 401**：检查密钥。模型发现会调用 OpenAI 兼容的 `GET /models` 端点；对于不提供该端点的服务，请手动输入模型。
- **图片在发送前被拒绝**：该模型未声明图片模态。请给自定义提供方的模型加上 `input: [text, image]`；DeepSeek 自身的 chat-completions 路由是纯文本的，且无法通过配置改变。
- **提供方拒绝了带图片的请求**：该模型声明了其端点实际并不提供的图片能力。请从授予它图片能力的那个列表中移除 `image`——可能是模型的 `input`，也可能是路由的 `defaultInput`——然后开启新会话：附加的图片会留在会话日志里，因此在会话离开它之前，同一个请求会不断重复。

## 进阶配置

自动生成的[插件配置目录](../../config-catalog.md)列出所有受支持的字段与默认值。[`roos-llm-pi-ai`](../../../packages/llm/llm-pi-ai/README.md) 和 [`roos-llm-deepseek`](../../../packages/llm/llm-deepseek/README.md) 参考文档负责直接 `settings.yaml` 配置、目录解析、推理控制、凭据与适配器错误。首次运行选择器约定见 [`roos-first-run-setup`](../../../packages/core/first-run-setup/README.md)。[CLI 模型指南](./models.md)负责 `roos models` 与 `roos providers`。
