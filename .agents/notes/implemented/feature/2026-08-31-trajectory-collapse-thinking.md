# Agent Note: collapse adjacent reasoning into one thinking entry

Status: implemented

## Problem

The trajectory raw source view renders each assistant message block as its own source entry. A provider that emits reasoning in several adjacent blocks (for example a reasoning block before and after each tool call, or a long chain split across blocks) produced a wall of one-row-per-block "thinking" entries, each showing its full text. For a multi-step run this buried the surrounding tool calls and text under many full reasoning rows.

## Decision

Coalesce each maximal run of adjacent reasoning blocks in one assistant message into a single thinking source entry, collapsed by default and expandable to every segment.

- **Entry shape.** A thinking entry carries `segments: string[]` (one per coalesced reasoning block, in source order) plus `content` (the segments joined with a blank line). `content` keeps existing consumers working unchanged: the message-level `thinkingDetail` preview and the search index read the joined text, and the renderer falls back to `content` for a single segment. The `segments` field is optional on `TrajectorySourceBlock` and present only on thinking entries.
- **Coalescing is view-only.** `assistantSourceBlocks` in layout.ts pre-passes a message's blocks: it accumulates adjacent `reasoning` blocks into a run and flushes one thinking entry per run, mapping every other block through the existing `assistantSourceBlock`. The runtime classification (`AssistantBlock` kind `reasoning`) and the session log are untouched; grouping is a ui-trajectory presentation concern.
- **Renderer.** The thinking entry renders a header button labeled from the `trajectory` locale (`thinking.label` = "Thinking") with the segment count shown when greater than one (`thinking.segments` = "{count} segments"). It is collapsed by default (`aria-expanded=false`), keyboard operable, and expands to show every segment's full text with the existing reasoning styling, segments separated by a divider. A single reasoning block renders as one full-text entry with no count; note the header vocabulary changes for all thinking rows - the generic `Block #N thinking` label becomes the localized `Thinking`, thinking entries carry no positional number, and later blocks' numbers are entry indices rather than source-block indices. The collapsed header shows the first line of the newest segment as a live preview; during streaming the newest segment grows, so the preview updates live, preserving the existing live-reasoning-text property for the trailing group.
- **State.** Expanded/collapsed is component-local (`useState` in `ThinkingSourceBlock`); no store change.
- **Locale.** The label and count come from the `trajectory` locale dictionary, threaded from the view's bound `t` through the table to the source-block renderer.

## Verification

The layout suite proves `[reason,reason,reason,tool,reason,reason]` yields two thinking entries with 3 and 2 segments plus the tool-call entry in order, that a single reasoning block yields one thinking entry, and that a streaming partial with two reasoning blocks appends both to the trailing group. The table suite renders a multi-segment thinking entry collapsed with the count and the newest segment's first-line preview, expands it to reveal every segment, and renders a single reasoning block as one full-text entry. `pnpm exec vitest run packages/client/ui-trajectory` is green; `pnpm exec tsc -b packages/client/ui-trajectory` shows no ui-trajectory errors (the only tsc output is the pre-existing generated `*/remote` subpath requirement in api/remotes and client/runtime).

## Alternatives considered

- **Group in the runtime classification instead of the view.** Rejected: `AssistantBlock` kind `reasoning` is the runtime's model-visible classification, and changing it would ripple through the session log and every consumer. Coalescing in ui-trajectory keeps the change to presentation and leaves the runtime and log untouched.
- **Merge across non-reasoning blocks instead of per-run.** Rejected: the goal is to collapse the wall of adjacent reasoning rows while preserving interleaving. Merging reasoning across a tool call would hide the tool boundary and lose the per-run grouping the task requires; coalescing each maximal run keeps reasoning split by a tool call as separate groups.
- **Joined text only instead of a segments array.** Rejected: a single joined string cannot render each segment separately or count them. Carrying `segments` alongside the joined `content` gives the renderer the per-segment structure while keeping `content` for existing preview and search consumers.

## Consequences

- The raw source view collapses a multi-block reasoning chain into one expandable entry, reducing the wall of Think rows while keeping every segment reachable on expand.
- The message-level `thinkingDetail` preview and search index continue to read the joined text, so no consumer outside the source-block renderer changed.
- The locale dictionary gained two keys (`thinking.label`, `thinking.segments`); the table now requires the bound `t` prop, threaded from the view.
