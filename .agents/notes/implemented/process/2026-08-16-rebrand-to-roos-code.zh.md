# Agent Note: 将产品重命名为 Roos Code

Status: implemented

[English](2026-08-16-rebrand-to-roos-code.md) | 中文

## 问题

本仓库此前以 DeepSeek Harness 之名发布：npm 包是 `@deepseek-ai/dsh-*`，CLI 是 `dsh`，环境变量是 `$DSH_*`，用户目录是 `~/.dsh`。这些名字属于 DeepSeek 产品。要在另一个组织下发布的 fork 不能继续占用它们：scoped 包会占用 `@deepseek-ai`，hook 脚本和环境约定会绑在 `DSH_*` 上，用户数据还会写进 `~/.dsh`。目前没有外部消费者，兼容层只会保住一个项目正在离开的名字。

## 决定

产品名是 Roos Code。一次脚本化的机械改写（`scripts/rebrand.ts`，由 `hygiene` 中的 `rebrand:check` 核验）把所有现行引用一起改掉。没有兼容层，也没有磁盘迁移：后端拒绝旧格式。

| 旧 | 新 |
|---|---|
| `@deepseek-ai/dsh-<x>` | `@roos-code/roos-code-<x>` |
| `@deepseek-ai/dsh` | `@roos-code/roos-code`（`bin` `dsh` → `roos`） |
| `@deepseek-ai/cordis` 及其余 vendored 家族 | `@roos-code/cordis` 及相同后缀 |
| `@deepseek-ai/node-addon-landlock-run*` | `@roos-code/node-addon-landlock-run*` |
| `DSH_*` | `ROOS_*` |
| `~/.dsh` / `.dsh` | `~/.roos` / `.roos` |
| `dsh-v` / family id `'dsh'` | `roos-v` / `'roos'` |
| `DeepSeek Harness` | `Roos Code` |
| `github.com/deepseek-ai/deepseek-harness` 与 `github.com/deepseek-harness/deepseek-harness` | `github.com/roos-code/roos-code` |
| `deepseek-harness-sdk` / `deepseek_harness` / `deepseek-harness-runtime-bin` / `deepseek_harness_runtime` | `roos-code-sdk` / `roos_code` / `roos-code-runtime-bin` / `roos_code_runtime` |
| `.agents/skills/dsh-*` | `.agents/skills/roos-*` |

改写不碰 DeepSeek API 约定（`DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`、`https://api.deepseek.com`）、提供方路由 id `deepseek-official`、插件 id `llm-deepseek` 与 `web-search-deepseek`、模型 id、Cordis 协议 token（`cordis.yml`、`cordis:` 内建前缀、`Symbol.for('schemastery')`）、`cordis` agent-preset 目录、`~/.agents`、根目录 `LICENSE`（原文 `Copyright (c) 2026 DeepSeek` 保留），以及冻结的 `.agents/notes/**`。根目录 `NOTICE` 写明 Roos Code 是 DeepSeek Harness 的衍生作品，并列明 `@roos-code/cordis` 家族的 vendored 来源。`scripts/verify-no-legacy-brand.ts` 在该保留名单之外拒绝残留的 `@deepseek-ai/dsh`、`DSH_[A-Z]`、`~/.dsh`、`deepseek-harness-sdk` 和 `DeepSeek Harness`。

`DSH_*` → `ROOS_*` 对读取 `DSH_SESSION_ID`、`DSH_SESSION_JSONL`、`DSH_SHELL`、`DSH_HOME` 等变量的 hook 脚本和子进程是破坏性环境约定变更。没有别名。用户目录是全新的 `~/.roos`；已有的 `~/.dsh` 不被读取，也不被改动。

## 考虑过的替代方案

**保留 `@deepseek-ai/dsh-*`，只改对外产品名。** 否决：以 `@deepseek-ai` 发布会占用该组织，环境变量、家目录和 bin 名仍在说 DeepSeek。

**给 `DSH_*` 做别名，并把 `~/.dsh` 复制或符号链接到 `~/.roos`。** 否决：预发布没有需要迁移的外部消费者，别名会把这次断裂藏起来，读取旧家目录还会把两个产品的凭据和会话日志混在一起。

**只在打包时改名。** 否决：发出去的名字与源码树不一致，本地也没有任何一次运行能复现发布出去的东西。

**手改约 3,300 个文件。** 否决：rebase 或漏掉一处正则就会让名字再次分叉；映射、路径改名、精确改写和 `--check` 由 `scripts/rebrand.ts` 承载。

## 影响

- 再安装或 import `@deepseek-ai/dsh-*` 解析不到本仓库。消费者改用 `@roos-code/roos-code-*` 和 `roos` bin。
- 读取 `DSH_*` 的 hook 脚本和子进程环境必须在同一次升级里改成 `ROOS_*`。
- 改名之后新建的用户数据落在 `~/.roos`。需要旧设置的人自己拷；产品不会代劳。
- `scripts/rescope-vendor.ts` 现在把上游 Cordis 名映射进 `@roos-code`，不再进 `@deepseek-ai`。`pnpm run rescope-vendor:check` 与 `pnpm run rebrand:check` 都在 `hygiene` 里跑。
- 内嵌身份字符串的 snapshot fixture（`roos-code/<version>`、`harness:source` 段、CLI 名 `roos`）用同一张 token 表改写，keyless replay 不必重新录制即可保持绿色。
