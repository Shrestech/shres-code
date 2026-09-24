# Agent Note: Stable prompt prefix through section stability classes

Status: implemented

## Problem

Provider prompt caches reuse a request at most up to its first changed byte. Every provider in use orders the request as tool schemas, then the system prompt, then conversation messages, so a system-prompt byte that changes between two requests on the same model invalidates every cached token after it, including the whole conversation history. On the Anthropic route a cold rewrite of that history is billed as a cache write at 1.25× the input price for the 5-minute lifetime, against 0.05× for a read on Opus 5.5.

A live session on 2026-09-24 showed the failure: with no model switch, the system prompt of one same-model request header differed from the previous one at about character 1,507 of a roughly 110,000-character prompt, and the next request rewrote 269,146 cached tokens. A section that toggled during the session caused it.

The registry could not express that a section toggles. `PromptSection` carried only `name`, `order`, `text`, and `complete`, so nothing distinguished text that stays fixed for a session from text that appears, disappears, or changes, and nothing kept toggling text away from the start of the prompt.

## Decision

### The requirement

For a fixed provider, model, and configuration, the bytes of the cached request prefix must not change between steps or turns of one session. Content that toggles during a session does not belong in that prefix. The best home for it is a dynamic context (`ctx.systemPrompt.context()`): the agent loop logs a changed context snapshot at the conversation tail, so it never rewrites cached history. Text that must stay in the system prompt goes after every static section, which keeps the tool schemas and static sections byte-identical across a toggle. How much of that unchanged prefix a provider reuses depends on its cache boundaries. On the Anthropic route, pi-ai sends the whole system prompt as one block with one cache breakpoint, and its other breakpoints sit on the last tool, on the Claude Code identity block, and on the last user message, which follows the system prompt and so misses after a toggle; a toggle therefore reuses only the tool schemas and the identity block; automatic prefix caches such as DeepSeek's and OpenAI's reuse the unchanged prefix only up to their last cache boundary before the change ([provider detail](../../../../packages/core/system-prompt/README.md#kv-cache-effect)). Each toggle still invalidates the cached messages behind the system prompt, and the owner accepts that cost explicitly by declaring the section conditional.

### Stability classes

`PromptSection` has an optional `stability: 'static' | 'conditional'`. `'static'` declares that a section renders the same bytes on every assembly for a fixed configuration; `'conditional'` declares that it may appear, disappear, or change between assemblies. Variables count as configuration: a static section may interpolate `{{model}}`, because provider caches are already per model.

### Default: omitted means static

An omitted `stability` means `'static'`. No shipped section declares a class, so the ordering rule never fires for existing compositions and every rendered prompt is byte-identical to its form before this change. Treating undeclared text as part of the prefix also matches what provider caches already do: they cache every system-prompt byte. Only a section's owner knows whether its text toggles, so the class is an opt-in declaration by that owner.

### The ordering rule

`SystemPrompt.assemble()` sorts the effective sections, after scoped shadowing, and rejects the assembly when any static section is ordered at or after the first conditional section. The error names the conditional section, the static section it precedes, and both orders. Equal orders are rejected because registration order breaks ties and depends on plugin load order.

The check runs in `assemble()`, like the multiple-complete-section rule, because the effective set depends on the assembly's scope: a scoped section can shadow a global one of the same name, so one scope may be valid while the global assembly is not. It is skipped while an effective complete section is active, because that section is the whole rendered prompt. `system-prompt/assemble` listeners are not checked; a listener that inserts or reorders sections owns the byte stability of what it emits.

### Verification

`packages/core/system-prompt/tests/prefix-stability.spec.ts` registers static sections, including a variable-bearing multibyte persona, and three conditional sections. It then assembles every combination of the conditional sections being shown or hidden, toggled both by text and by registration and disposal. For each combination, it asserts that the rendered bytes before the first conditional section are identical and that all eight renderings differ. The same file pins the rule: a conditional section before a static section whose stability is omitted, equal orders in either registration order, disposal of the owning fiber, scoped misordering, scoped shadowing, and the complete-section exemption. With the rule disabled, the five rule tests fail.

### Migration of toggling sections

This decision establishes the requirement and the registry mechanism only. Each owner of a section that toggles during a session migrates it separately, preferably to a dynamic context, otherwise by declaring `stability: 'conditional'` and ordering it after every static section. Until its owner migrates, an undeclared toggling section keeps invalidating the cache from its position, and the rule cannot detect it.

Related decisions: the conventional order bands come from [prompt variables and tool-guidance ownership](2026-07-05-prompt-variables-and-tool-guidance-ownership.md), and the plugin-owned layout from [system-prompt layout without an agent-loop change](2026-09-16-system-prompt-layout-without-loop.md).

## Alternatives considered

**Default to `'conditional'`, or require every registration to declare a class.** A conditional default makes every undeclared section conditional, so the prefix guarantee covers nothing and the stability check asserts nothing. A required field changes every section registration in the repository in one change without adding information: each owner already knows its text, and the default states the assumption provider caches already make.

**Reserve an order band for toggling text instead of declaring a class.** A band such as orders of 1000 and above is only a convention: nothing stops a static section from using the band or a toggling one from sitting below it. The declared class records the fact the rule depends on, so the registry can enforce the ordering.

**Enforce the rule at registration.** Registration sees one layer, while the effective set depends on scoped shadowing at assembly. A registration-time check would reject one of a valid pair whose global misordering a scope repairs, and would blame whichever section registered second. Assembly is the earliest point where the effective set is resolvable, as for multiple complete sections.

**Detect instability by hashing sections across assemblies.** Comparing rendered sections between assemblies needs per-session memory the registry does not own, and reports a toggle only after it has already invalidated the cache. A declaration lets the rule act before any request is sent.

**Forbid system-prompt sections that toggle.** Some content needs system-prompt placement, and migrating every current section to a dynamic context is owner work outside this registry. The conditional class makes the remaining cost explicit instead.

## Consequences

Compositions that declare no class render byte-identical prompts, so this change has no model-visible or cache effect by itself. A deployment that declares a conditional section gets a loud assembly failure instead of a silent cache-busting order, and the error names both sections. Ordering conditional sections last keeps only the tool schemas and static sections byte-identical, and a provider reuses them only up to its own cache boundaries: on the Anthropic route the static sections share the system-prompt block with the conditional text and are written again with it. A toggle still invalidates every cached message after the system prompt, so the mechanism narrows the damage rather than removing it; a dynamic context avoids it. Stability is a declaration the registry trusts; an owner who toggles text without declaring it still busts the cache.
