# Agent Note: J-Space control loop

Status: implemented

## Problem

The Settings remount and four tools existed, but a normal multi-step turn still failed as a product. Loop-shaped text auto-opened a stock card, then `jspace_open` refused with “already open.” The protocol did not tell the model how to drive the tools. Self-monitoring copy was never mounted. An identical tool call could repeat with no diagnosis. The todo strip and the J-Space dock both claimed “what we are doing.”

## Decision

`jspace_open` on an already-open card updates Goal and Next through `note` and returns `Updated J-Space.` Service `open()` still throws, so `/j-space on` stays a no-op when a card exists. Assemble still auto-opens a stock card on `loop`; the model can then overwrite those lines.

`jspace:protocol` always includes tool-driver lines while the seat is active: how to open, or how to note / checkpoint / ship without a second open. `full` and `loop` mount self-monitoring. A long loop also mounts shorthand.

While a native card is open, `tools/pre-execute` refuses a non-card tool whose name and canonical arguments match the last prior `tool/call`, unless a later `jspace/card` or `jspace/closed` write sits between them. The in-flight `callId` is skipped because the loop logs `tool/call` before the waterfall. Card tools never trip the refuse.

The todo plan strip renders nothing while `useProjection('jspace').card` belongs to the live session.

## Alternatives considered

**Keep `jspace_open` as a hard fail after auto-open.** Rejected: the live model followed the user instruction and the product looked broken.

**Require a `diagnosis` field on every tool.** Rejected: bash and fs schemas cannot grow a J-Space field. A card write is the diagnosis the ledger already stores.

**Leave the todo strip up beside the dock.** Rejected: two clocks in the composer was the stated product defect. Hiding the strip does not change todo’s turn-boundary lifetime.

## Consequences

A stock auto-open no longer blocks stating the real Goal. The model is told the tools on every enabled request, including `fast`. Blank identical retries fail until the card moves. The todo strip yields to an open native card. GoalBar unification and W0 measurement stay deferred.

## Related

The remount and card inventory live in [J-Space as a Settings-toggled harness card](2026-08-18-jspace-settings-toggle.md).
