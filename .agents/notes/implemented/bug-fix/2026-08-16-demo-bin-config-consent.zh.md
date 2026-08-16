# Agent Note: Demo bin 需要显式配置同意，并拒绝未受信任的 !!js

Status: implemented

[English](2026-08-16-demo-bin-config-consent.md) | 中文

## 问题

`dsh-acp-demo` 把缺失的 `--config` 当成调用目录下的 `./cordis.yml`。因此，只要 bin 一启动，放了该文件的检出就可以用操作者的权限运行 `!!js` 表达式和相对插件 `name:` 值（`./x.js`）。`dsh-jsonrpc-agent` 已经要求显式路径，但两个 bin 都通过未加固的 `loadEnv` 加载调用目录的 `.env`，同一检出因此可以在任何插件挂载之前设置 `DEEPSEEK_BASE_URL`、`SSL_CERT_FILE`、`HOME` 或其他 bootstrap 名称。

传入 `--config` 表示操作者点名了一个文件。这是加载该 YAML 的同意，并不是执行任意 JavaScript、或从操作者未预批准的目录导入相对插件的同意。

## 决策

两个 bin 都要求显式配置路径，绝不会默认加载 CWD 下的 `cordis.yml`。`dsh-acp-demo` 接受 `--config`／`-c`。`dsh-jsonrpc-agent` 接受 `$DSH_CORDIS_CONFIG` 或位置参数 `argv[2]`。缺少路径时打印用法并退出；点名的路径不存在则按找不到失败。

显式路径会按原始 YAML 文本扫描 `!!js`，以及以 `./` 或 `../` 开头的 `name:` 值（冒号前允许空格，路径前允许 `!!tag`，例如 `!!str`）。包含任一构造的文件，在其规范路径为 `$DSH_HOME` 或其子孙，或位于从模块 URL 和 `process.execPath` 向上发现的第一方树内时允许（绝不从调用目录出发）：本 harness 源码检出（`pnpm-workspace.yaml` 加上两个 demo 包）、附带 `runtime/cordis.yml` 或与 `node/` 同级的 `cordis.yml` 的已打包运行时、或已安装的 demo 包目录。对 Python SDK 的 pkg `--sea` 载体必须走真实 exe：其 `import.meta.url` 是 `file:///snapshot/...`，而磁盘上的 `runtime/cordis.yml` 与 `runtime/dsh-jsonrpc-agent-pkg-*` 同级。其他位置会失败，诊断会说明将文件放到 `$DSH_HOME` 下即可预批准这些构造。两种构造都没有的文件可以放在任何位置。

该扫描是尽力而为的原始文本过滤，不解析 include，也不覆盖每一种 YAML 编码。硬保证是：这些 bin 绝不会在没有显式路径的情况下加载 CWD 下的 `cordis.yml`。

两个 bin 都通过 `loadLayeredEnv` 加载环境文件；该函数在应用项目或 home 的 `.env` 之前拒绝 bootstrap-only 名称。`dsh-acp-demo` 在 `DSH_SNAPSHOT=replay` 时仍会跳过这次加载，并在选定已同意路径之后运行 `resolveConfigPath`，以便回放把 `cordis.yml` 换成同级 `cordis.snapshot.yml`。

resolver 分别放在两个 demo 包中（`resolveDemoConfig.ts`）。这两个包互不依赖。

## 考虑过的替代方案

**保留 CWD 默认值并打印警告。** 警告无法阻止进程对恶意 `cordis.yml` 中的 `!!js` 求值。默认值本身就是漏洞。

**把每一次显式 `--config` 都当成完整同意，包括不受信任检出中的 `!!js`。** 点名文件是同意将其作为配置加载。`!!js` 和相对 `name:` 会执行代码。第一方叶子和已打包的 `runtime/cordis.yml` 按位置批准；随机检出不批准。

**拒绝 `$DSH_HOME` 之外的每一个 `!!js` 文件。** 这会破坏 `pnpm demo:acp`、快照套件，以及 Python SDK 附带的 `runtime/cordis.yml`。那些文件是第一方或随发行版交付的，不是恶意 CWD 默认值。

**把一份包内 ACP `cordis.yml` 作为无标志默认值交付。** 安全属性是「绝不使用 CWD 默认值」，不是「总要启动点什么」。要求 `--config` 与 JSON-RPC bin 一致，也不会再发明第二套组合。

**把 `$DSH_HOME` 指到 `examples/`，好让第一方叶子通过 home 检查。** 这会把 skill（技能）、settings 和 home `.env` 一并搬走。按 bin 安装树做位置允许列表，才能让 home 继续作为用户数据根。

**把该辅助函数放进 `dsh-app-boot`。** 产品 CLI 已有自己的启动路径。为一个仅用于 demo 的同意规则扩大 app-boot 的职责，不如让两个 bin 各自拥有该辅助函数。

## 后果

在不受信任的检出中 `cd` 后不带标志运行 `dsh-acp-demo`，不再挂载该检出的 `cordis.yml`；bin 要求 `--config`。同一检出里带 `!!js` 或相对插件 `name:` 的显式 `./cordis.yml` 仍会被拒绝，除非把文件复制到 `$DSH_HOME` 下。`demo:acp`、`examples/` 下的快照叶子，以及已打包 Python 运行时的 `runtime/cordis.yml` 会继续工作，因为它们位于第一方或已打包树中。恶意 `.env` 不能再通过这些 bin 重定向 `DEEPSEEK_BASE_URL` 或改写 `HOME`。

## 测试

每个 demo 包的 `resolve-demo-config.spec.ts` 固定了针对 CWD `cordis.yml` 的必需路径、第一方 `examples/*/cordis.yml` 叶子、harness 检出 fixture（测试前置数据）、已打包运行时 fixture、pkg snapshot 模块 URL 加上磁盘 exe 旁的 `runtime/cordis.yml`、必须继续拒绝的 CWD `runtime/cordis.yml`、在所有批准位置之外的 `!!js` 与相对 `name:`（包括 `name :` 和 `!!str`）、`$DSH_HOME` 下的批准、home 外且两种构造都没有的文件、缺失的显式文件，以及符号链接规范化。
