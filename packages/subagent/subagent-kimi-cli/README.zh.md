# @roos-code/roos-code-subagent-kimi-cli

[English](README.md) | 中文

本包注册固定的 `kimi-cli` subagent 提供方。每次接受运行请求后，它都在发起委托的会话工作区中启动官方 Kimi Code CLI 的 `kimi -p`，提交一个自包含文本任务，并通过共享的 [`roos-subagent`](../subagent/README.md) 结果约定只返回最终答案。

无头标志、stream-json 解析模式、鉴权与思考映射记录在 [Kimi CLI spike](../../../.agents/notes/implemented/architecture/2026-08-16-kimi-cli-headless-spike.md)。

## 启动与所有权

`start(request)` 只接受非空文本块序列，并根据父会话确定子级 cwd。除非设置了 `executable`，否则从 `PATH` 解析 `kimi`，然后通过 [`roos-subprocess`](../../subprocess/subprocess/README.md) 启动 `kimi -p <task> --output-format stream-json --yolo`。发布前的失败或取消会终止受管进程树并拒绝 `start()`。

已发布的 `run.result` 等待进程退出。退出码 0 且 stream-json 事件含有非空 `result` / `text` / `message` 时结算为 `completed`。非零退出或没有答案的流结算为 `error`。本地取消映射为 `aborted`。`dispose()` 具有幂等性：终止进程树并等待整棵树退出。

## 能力与上下文

提供方不公布可选启动能力，并报告 `inheritsParentContext: false`。Kimi 收到独立文本任务和父会话 cwd，但收不到父级对话、人设、工具过滤或深度策略。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `env` | `{}` | 叠在子进程 seam 已清洗父环境之上的显式子环境。 |
| `disposeGraceMs` | `3000` | 正有限宽限毫秒数，不得大于 [`MAX_TIMER_DELAY_MS`](../../util/timeout/README.md)。 |
| `executable` | `kimi` | Kimi Code CLI 二进制的绝对路径或 PATH 名。 |

凭据形态的环境变量会被子进程 seam 去掉，因此给子进程用的 API 密钥必须显式写进 `env`。

```yaml
- id: subagent-kimi-cli
  name: '@roos-code/roos-code-subagent-kimi-cli'
  config:
    env:
      MOONSHOT_API_KEY: !!js process.env.MOONSHOT_API_KEY

- id: tool-subagent-kimi-cli
  name: '@roos-code/roos-code-tool-subagent'
  disabled: true
  config:
    provider: kimi-cli
    toolName: subagent_kimi_cli
    enableRunInBackground: false
    maxDepth: provider-managed
```

## Model Experience

### 子请求

#### 模型看到什么

Kimi 子进程把独立文本块当作一次 `kimi -p` 提示。其工作区是父会话 cwd。模型、工具、沙箱和鉴权来自本机 Kimi Code CLI 安装。

#### Token 影响

子进程支付独立的 Kimi 上下文。子 token 不进入父上下文。

#### KV Cache 影响

与父请求缓存无关。

### 父工具结果（间接）

#### 模型看到什么

通过 `roos-tool-subagent`，父级只看到选中的最终 Kimi 答案或消费方给出的精确错误。Kimi 评论、工具活动和产品 id 不会复制进父会话。

#### Token 影响

父输入只因工具结果中保留的最终答案或错误而增长。

#### KV Cache 影响

仅追加：新工具结果跟在可复用的父请求前缀之后。

## Known Limitations and Deferred Work

- **每次运行一个全新进程和提示** — 没有续跑、恢复或进度流。
- **由主机管理产品安装** — 缺少 `kimi` 是启动错误；本插件不负责安装或登录。
- **Kimi 自带工具绕过 harness 审批** — 无人值守的一次性运行需要 `--yolo`。
- **只有最终文本** — 推理、工具流量和工作区 diff 留在产品本地。
- **较旧的 `kimi --print` 二进制** — 覆盖 `executable`，并且不要假定已交付的 `-p` argv，除非该二进制接受它。
