# Agent Note: Untrusted frame util for remote model-visible text

Status: implemented

[English](2026-08-16-untrusted-frame-util.md) | 中文

## 问题

不受信任的文本会从不止一个消费方进入模型。跨会话快照、抓取到的页面，以及搜索答案或摘要，都可能包含当前 user 并未写过的指令、权限声明或形似工具请求的内容。载荷还可以拼出 XML 风格的结束标签，从而冲出消费方以为自己拥有的包装。

`roos-session-reference` 已经为其中一个调用方解决了这个问题：一段说明不要遵循载荷内部指令的受信任文字、包住数据的 XML 风格标签，以及无损的 `<` → `\u003c` 转义，使源文本无法关闭这些标签。Web 抓取和搜索在渲染提供方文本时没有对等包装。下一个消费方（项目来源的 skill）会再次复制这三部分，而这些副本会逐渐分化。

## 决策

`@roos-code/roos-code-untrusted-frame` 位于 `packages/util/`，只负责机械包装。它是纯函数库，**不是** Cordis 服务或插件：不接受 `ctx`，不注册任何内容，不持有状态，也不发出事件。

该库导出 `escapeUntrusted`、`stringifyTagSafeJson`、`wrapUntrusted`、`frameUntrusted`、共享免责声明 `UNTRUSTED_INSTRUCTION_DISCLAIMER`，以及 `\u003c` 替换值 `UNTRUSTED_LT_ESCAPE`。调用方选择标签名和说明的首句，并把受信任元数据留在定界框外。

当前调用方：

- `roos-session-reference` 把 JSON 快照框在 `<referenced-sessions>` 中。模型可见字节与原先内联的前缀和后缀相同。
- `roos-tool-web` 的 `web_fetch` 把已解码页面框在 `<untrusted-web-page>` 中。`Fetched <url> (HTTP <status>)` 状态头和截断页脚留在框外。
- `roos-tool-web` 的 `web_search` 在存在答案或任何来源时发出一次共享免责声明，把答案包进 `<untrusted-web-answer>`，并把每条摘要包进 `<untrusted-web-snippet>`。来源标题、URL、日期、缩小查询的说明和引用指令留在框外。
- `roos-skill` 的 `renderSkillContent` 为 `project-*` 来源前置共享免责声明，并复用 `UNTRUSTED_LT_ESCAPE` 中和每个正文中的 `</skill_content>` / `</skill_instructions>`。`<skill_content>` 标签和资源提示留在该转义之外。见 [skill 定界 Agent Note](2026-08-16-skill-body-escaping-trust-framing.md)。

`stringifyTagSafeJson` 仍是同一转义的 JSON 形式，因此 session-reference 的字节预算仍按定界后的载荷计量。

## 考虑过的替代方案

**在 `roos-tool-web` 中复制 session-reference 的前缀和转义。** 否决，因为下一个不受信任的消费方还会再复制一次，之后对免责声明或转义的修改无法到达每一处。

**只在系统提示词中警告，不做转义。** 否决，因为包含 `</untrusted-web-page>` 的载荷仍会关闭包装；一句提示词无法修复被冲破的定界框。

**对整个载荷做 HTML 转义，或剥掉标签。** 否决，因为它改动的字符比阻止冲出定界框所需的更多。session-reference 的 JSON 形式已经需要一种 `JSON.parse` 可以还原的无损转义。

**在展示前用 LLM 总结或改写远程文本。** 因成本否决，而且摘要本身仍需要定界框。

## 后果

- 抓取页面和搜索答案／摘要会因免责声明与标签而变长；载荷中的每个 `<` 都会变成六个字符的 `\u003c` 转义。markdown 转换仍在 fetch 定界之前运行，因此普通转换后的页面很少包含 `<`。
- 能容纳状态头、空定界框和截断页脚的 `fetchMaxOutputChars` 上限总会在页脚之前关闭 `</untrusted-web-page>`。更小的上限仍会切开最终字符串（包括标签）。
- session-reference 快照保持原先字节；只有导入路径变了。
- 项目来源的 skill 复用免责声明和 `\u003c` 转义；它们保留自己的 `<skill_content>` 标签，而不是对整块调用 `frameUntrusted`。
