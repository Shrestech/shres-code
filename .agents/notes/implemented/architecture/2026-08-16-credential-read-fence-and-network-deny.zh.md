# Agent Note: Credential read fence and default-deny sandbox network

Status: implemented

[English](2026-08-16-credential-read-fence-and-network-deny.md) | 中文

## Problem

进程内文件系统围栏只约束写入，每种模式仍可读取宿主进程能打开的任意路径，因此模型控制的 `read` 只要指向 `$ROOS_HOME/.credentials.yaml`（或某个 `*.credentials.yaml` 别名）就能带走提供方密钥。与此同时，Seatbelt 和 Landlock 只约束文件效果，出站 TCP 仍开放；原先只假定 bwrap 会隔离网络，而该 profile 其实也没有 `--unshare-net`。因此受限制的子进程可以在 macOS 和 Linux Landlock 上访问任意主机，在这次改动之前，Linux bwrap 同样如此。

## Decision

**`roos-fs-sandbox` 中始终生效的凭据读取围栏。** `readText`／`streamText`／`readBytes` 走 `checkedTarget()`，并像写入一样重新规范化。除 `danger-full-access` 外的每种模式都会拒绝 `$ROOS_HOME/.credentials.yaml`、任何 `*.credentials.yaml` 基名，以及每条经过验证的 `denyReadPaths` 条目，并抛出 `FS_SANDBOX_DENIED`。home 文档还会按解析后的身份匹配，因此工作区中的符号链接无法绕过围栏。

**在 `ctx.sandboxPolicy` 上增加经过验证的 `network: 'allow' | 'deny'`，默认 `deny`。** `resolve()` 总会携带该字段。`sandboxNetwork()` 把手工构造且省略该字段的策略视为 `deny`。Seatbelt 添加 `(deny network-outbound)`；bwrap 添加 `--unshare-net`；Landlock 的文件系统授权保持原样，并在内核 ABI 支持时拒绝 TCP bind/connect。`network: allow` 会解除 Seatbelt／bwrap 规则，并向 `landlock-run` 传入 `--allow-net`。

**完整的 TCP 拒绝需要 Landlock ≥ 6.7（ABI 4）。** launcher 仅在 `landlock_create_ruleset` 报告 ABI ≥ 4 后才加入 `handled_access_net`（若遇到 `E2BIG`／`EINVAL` 则去掉 net 属性重试）。更旧的内核保留文件系统规则集，现有探测会报告 `partial`，而不会让包装失败。

## Alternatives considered

- **只拒绝精确的 `$ROOS_HOME/.credentials.yaml` 路径**：工作区里名为 `provider.credentials.yaml` 的副本，或带无害 display path 的符号链接，仍然会泄漏。基名 glob 加上身份匹配可以封住这些别名。
- **只在内核层拒绝网络、不设策略字段**：Seatbelt／Landlock 会在没有操作方逃生口的情况下改变行为，bwrap 也无法再选择接入网络。经过验证的配置字段才是部署旋钮；`DEFAULT_*` 常量并不是可配置性。
- **ABI < 4 时让 Landlock 包装失败**：已经用 Landlock 约束文件的 Linux 主机会完全失去隔离。报告 `partial` 可以保留文件效果，并告诉消费方 TCP 承诺并不完整。
- **把 `network` 只放在 `sandbox-local` Config 上**：从 `ctx.sandboxPolicy.resolve()` 构造 `SandboxPolicy` 的 bash 等消费方将看不到它。策略归属位置是逐调用隔离输入的唯一所有者。

## Consequences

通过 `ctx.fs` 读取受管凭据文档需要 `danger-full-access`。额外的禁止读取路径是插件配置，不是会话覆盖。现在默认拒绝出站网络的平台包括 macOS Seatbelt、Linux bwrap（新增 `--unshare-net`），以及 ABI ≥ 4 时的 Linux Landlock；需要子进程联网的操作方应在 `sandbox-policy` 上设置 `network: allow`。Windows ACL 不变。低于 6.7 的 Landlock 内核仍会约束文件并探测为 `partial`。
