# Agent Note: Host 插件激活审批

Status: implemented

[English](2026-08-16-host-plugin-activation-approval.md) | 中文

## 问题

模型编写的动态 Cordis Plugin 的 Host 半在与 harness 相同的进程里求值，并能触达存活服务（`ctx.shell`、`ctx.fs`、`ctx.web`）。带 Client 的 Package 已经在页面上等人（`cordis/request-run`）。只有 Host 半的 Package 过去会立即启动，因此特权代码没有任何同意步骤，也没有复用现有的审批 seam。

无人值守组合（headless snapshot、CI）仍然需要在没有交互应答者的情况下启动一个已知 Plugin；缺失或失败的应答者必须故障关闭，而不是启动 Host 代码。

## 决定

`DynamicCordisRunnerService.activate()`／`startFresh()` 在求值任何 Host 半之前询问 `ctx.approval`。这次询问对该 Session 中的每个 Plugin id 只进行一次，并在该 Plugin 上串行化：`'allowed-once'` 会设置 `plugin.hostActivationApproved`，该 Plugin 此后的 Package 或重启不再询问。唯一许可是 `'allowed-once'`；`rejected`、`cancelled` 和 `unavailable` 会在 `startHost` 之前拒绝，并被记住，因此重试不会再次提问。只有 Client 的 Package 从不询问。带 Client 的 Package 在取得 Host 半许可之后，仍会 emit `cordis/request-run` 并保留现有的页面卡片。面板 `runHostHalf` 只在 Host 激活成功之后才记录 Client 许可。

runner 注入 `approval`，因此缺少该 seam 的组合在加载时保持 pending。配置项 `hostActivationAllowlist`（默认 `[]`）列出跳过询问的已铸造 Plugin id（`<prefix>-<n>`）；schema 在加载时拒绝非法条目。`cordis_run` 对这三种拒绝返回结构化的非错误结果，告诉模型不要重试；repeat-tool-reminder 链仍会观察完全相同的调用。不在开放轮次内的询问是 `ApprovalOutsideTurnError`，用 `isApprovalOutsideTurnError` 识别。

`pnpm run demo:cordis`（默认 Web，或 `acp`）现在会在 Host 半运行之前，通过已组成的审批应答者提问。实况 advanced／e2e 组合不会静默 allowlist `snap-1`；只有无人值守回放的 `*.snapshot.yml` 会列出该 id。

## 曾考虑的替代方案

**单独为 Host 半再做一套审批事件或面板，不走 `ctx.approval`。**否决，因为审批 seam 已经拥有一次性许可、审计事件对、`ask`／`never` 策略以及 ACP／Web 应答者。第二条路径会与 bash／fs 升权漂移，并发明该 seam 故意没有的许可存储。

**把 Client 的 `cordis/request-run` 卡片复用到只有 Host 半的 Package。**否决，因为只有 Host 半的 Package 没有可装载的页面，headless 与 ACP 部署永远收不到该事件，而且该卡片是浏览器编排，不是进程权限许可。

**`allow-always` 或前缀通配 allowlist。**否决，因为审批词汇表没有持久许可，Plugin id 是铸造出来的（`<prefix>-<n>`），前缀通配会静默覆盖模型随后发明的每一个 Plugin。经过校验的精确 id 列表才是无人值守出口。

**拒绝时抛出工具错误。**否决，因为 `isError` 结果看起来像瞬时故障，会引发重试风暴。结构化的非错误结果陈述闭合决定；完全相同的重试仍会推进 repeat-tool-reminder 链。

## 影响

只有 Host 半的激活不再是静默的。交互式 Web 与 ACP 演示会询问用户；实况 advanced／e2e 组合必须组成应答者，无人值守回放的 `*.snapshot.yml` 则列出 `snap-1`。轮次结束后的面板 `runHostHalf` 会故障关闭（`unavailable`），而不是在没有可审计询问的情况下启动 Host 代码。`cordis` 预设 skill 与 `cordis_run` 描述写明 Host 半拒绝是最终结果。
