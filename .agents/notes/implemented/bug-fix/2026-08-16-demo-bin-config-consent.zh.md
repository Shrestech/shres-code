# Agent Note: Demo bin 需要显式配置同意，并拒绝未受信任的 !!js

Status: implemented

[English](2026-08-16-demo-bin-config-consent.md) | 中文

## 问题

`dsh-acp-demo` 把缺失的 `--config` 当成调用目录下的 `./cordis.yml`。因此，只要 bin 一启动，放了该文件的检出就可以用操作者的权限运行 `!!js` 表达式和相对插件 `name:` 值（`./x.js`）。`dsh-jsonrpc-agent` 已经要求显式路径，但两个 bin 都通过未加固的 `loadEnv` 加载调用目录的 `.env`，同一检出因此可以在任何插件挂载之前设置 `DEEPSEEK_BASE_URL`、`SSL_CERT_FILE`、`HOME` 或其他 bootstrap 名称。

传入 `--config` 表示操作者点名了一个文件。这是加载该 YAML 的同意，并不是执行任意 JavaScript、或从操作者未预批准的目录导入相对插件的同意。

## 决策

未指定 `--config` 时，`dsh-acp-demo` 使用本包捆绑的组合路径（由 resolver 模块 URL 推导），绝不会使用相对 CWD 的 `cordis.yml`。`dsh-jsonrpc-agent` 仍然要求 `$DSH_CORDIS_CONFIG` 或位置参数 `argv[2]`，仍然没有内置回退。

显式路径（`--config`、`$DSH_CORDIS_CONFIG` 或 argv）会按原始 YAML 文本扫描 `!!js`，以及以 `./` 或 `../` 开头的 `name:` 值。缺失的显式文件按找不到失败。位于 `$DSH_HOME` 之外且包含任一构造的文件会失败，诊断会说明将文件放到 `$DSH_HOME` 下即可预批准这些构造。位于 `$DSH_HOME` 下的文件（home 本身或其子孙，经过 `realpath`）可以包含这些构造。两种构造都没有的文件可以放在任何位置。

两个 bin 都通过 `loadLayeredEnv` 加载环境文件；该函数在应用项目或 home 的 `.env` 之前拒绝 bootstrap-only 名称。`dsh-acp-demo` 在 `DSH_SNAPSHOT=replay` 时仍会跳过这次加载，并在选定已同意路径之后运行 `resolveConfigPath`，以便回放把 `cordis.yml` 换成同级 `cordis.snapshot.yml`。

resolver 分别放在两个 demo 包中（`resolveDemoConfig.ts`）。这两个包互不依赖。

## 考虑过的替代方案

**保留 CWD 默认值并打印警告。** 警告无法阻止进程对恶意 `cordis.yml` 中的 `!!js` 求值。默认值本身就是漏洞。

**把每一次显式 `--config` 都当成完整同意，包括 `$DSH_HOME` 之外的 `!!js`。** 点名文件是同意将其作为配置加载。`!!js` 和相对 `name:` 会执行代码，需要单独预批准：文件必须位于 `$DSH_HOME` 下。

**即使在 `$DSH_HOME` 下也禁止 `!!js` 和相对插件名。** 这会去掉为使用这些构造的受信任组合提供的已记录预批准方式。放在 home 下就是批准。

**把该辅助函数放进 `dsh-app-boot`。** 产品 CLI 已有自己的启动路径。为一个仅用于 demo 的同意规则扩大 app-boot 的职责，不如让两个 bin 各自拥有约 80 行的辅助函数。

## 后果

在不受信任的检出中 `cd` 后不带标志运行 `dsh-acp-demo`，不再挂载该检出的 `cordis.yml`。想使用 `!!js` 或相对插件 `name:` 的操作者需先把文件复制或写到 `$DSH_HOME` 下。仍通过 `--config` 指向 `$DSH_HOME` 之外且含 `!!js` 的文件的第一方示例配置，会在同样检查下失败，直到它们也这样做。恶意 `.env` 不能再通过这些 bin 重定向 `DEEPSEEK_BASE_URL` 或改写 `HOME`。

## 测试

每个 demo 包的 `resolve-demo-config.spec.ts` 固定了无标志默认值、必需路径、`$DSH_HOME` 之外的 `!!js` 与相对 `name:`、`$DSH_HOME` 下的批准、home 外且两种构造都没有的文件、缺失的显式文件，以及符号链接规范化。
