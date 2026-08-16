# Agent Note: Skill body escaping and project-source trust framing

Status: implemented

[English](2026-08-16-skill-body-escaping-trust-framing.md) | 中文

## 问题

`renderSkillContent` 把 skill 正文原样嵌在 `<skill_instructions>` 与 `</skill_content>` 之间。正文只要写出这些结束标签，就会提前结束包装，并可以把随后的标记伪装成 harness 自己写的内容。

并非每个 skill 都同等受信任。`bundled` 与 `user-*` skill 来自操作者的安装或主目录。`project-roos` 与 `project-agents` skill 来自 `<projectRoot>/.roos/skills` 和 `<projectRoot>/.agents/skills`——检出中的文件，另一位作者可以改动。这些正文可以携带当前 user 并未写过的指令、权限声明或形似工具请求的内容。目录已经只含摘要；完整正文通过 `skill` 工具结果和用户显式的 `/name` 注入到达模型，这两条路径共享 `renderSkillContent`。

## 决策

`renderSkillContent` 仍然为两条加载路径拥有同一份 `<skill_content>` 块。信任判定默认关闭：只有 `bundled`、`user-*`、`runtime` 和 `custom` 是受信任的本地内容。`project-*`、任何其他标签以及缺失的 source 都不受信任。

- 受信任正文会中和一组结束标签——`</skill_content>` / `</skill_instructions>`，ASCII 大小写不敏感，`>` 前可有空白——把开头的 `<` 替换为 `UNTRUSTED_LT_ESCAPE`。其他标记（包括 `<tags>`）保持原样。`name` 属性仍按原先方式做 HTML 转义。
- 不受信任来源把不受信任定界框说明头放在 `<skill_content>` **内部**、指令正文之上，因此目录里「遵循该块」的句子会覆盖到免责声明。正文使用 `wrapUntrusted('skill_instructions', content)`，从而转义每个 `<`。资源提示留在外层块内、被包装的正文外。

`skill` 工具的结构化值携带 `source`，使 Native 渲染器能套用与用户显式注入相同的规则；后者本来就会收到完整的 `SkillDefinition`。

目录不变：它仍只发布 `name` 和描述。

## 考虑过的替代方案

**把每个 skill 都当作不受信任，并对整个正文运行 `escapeUntrusted`。** 否决，因为打包 skill 和用户主目录 skill 是操作者控制的本地内容。把每个 `<` 都转义会为它们并不具有的威胁改写 markdown。不受信任来源会经由 `wrapUntrusted` 运行 `escapeUntrusted`。

**只在系统提示词或目录中警告，不转义结束标签。** 否决，因为包含 `</skill_instructions>` 的正文仍会关闭包装；一句目录文字无法修复被冲破的定界框。

**把整个 `<skill_content>` 块包进 `frameUntrusted`。** 否决，因为那会转义 harness 自己的标签和 `name` 属性。受信任元数据（名称、资源提示）留在被包装的指令正文之外；说明头放在 `<skill_content>` 内，使目录所点名的块包含它。

**信任任何非 `project-*` 来源，包括未知标签和缺失的 source。** 否决，因为 `SkillSource` 是开放联合。将来的远程或 marketplace 提供方只要另选一个字符串就会以受信任身份发布。允许列表就是那四个本地受信任标签。

**像对待用户主目录 skill 一样信任项目 skill。** 否决，因为克隆下来的仓库不是当前 user 的写作。项目 skill 文件相当于 skill 语境下的抓取网页文本。

## 后果

- 项目 skill 的渲染会因 `<skill_content>` 内的说明头而变长，正文中的每个 `<` 都会变成 `\u003c`。加载 `project-*` skill 的快照（ACP 的 `skill-load`、web 的 skill 工具行、agent-spine 的热添加 skill 路径）会带上这些字节。打包 skill 的渲染（如 `roos-badge`）除新增的结构化 `source` 字段外保持字节相同。
- 提到该结束标签族的受信任正文现在会在仍然闭合的包装内显示 `\u003c/skill_content>` / `\u003c/skill_instructions>`（以及大小写或空白变体）。
- 目录模板和替换生命周期不谈论信任。仅正文渲染规则变化时，不必改目录。
- 新的远程提供方在被加入受信任允许列表之前都不受信任。
