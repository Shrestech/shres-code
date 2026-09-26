# Agent Note: Routing warnings share the composer without displacing controls

Status: implemented

## Problem

The routing chip shares a single composer row with the access-mode control and the model picker. An idle explanation or action failure can be longer than the remaining width. Letting the sentence retain its intrinsic width overlaps the controls or removes the model label, even though those controls remain actionable.

## Decision

The composer keeps its leading controls at their intrinsic size and gives the trailing group the remaining width. The routing warning yields before the model label: its visible copy is short, it truncates with an ellipsis, and a two-em minimum leaves a hover target instead of collapsing the explanation entirely. The routing toggle and Restore action remain independently visible. The [routing plugin README](../../../../packages/client/ui-model-routing/README.md) owns the state and interaction details.

The full warning remains in the tooltip and in visually hidden text linked by `aria-describedby`. Failure lines use the same presentation, with their full detail in the description and their action-specific label visible. Each rendered chip generates its own description IDs, so two sessions cannot reference one another’s explanations. This does not add a second control or change the [Routing view’s placement and mode ownership](../feature/2026-09-25-model-routing-session-view.md).

## Alternatives considered

Keeping the full sentence at its intrinsic width gives a status explanation priority over actionable controls. Hiding the warning removes the routing-idle state from the chat surface. A tooltip alone does not provide a linked text description for assistive technology. Wrapping the explanation adds a second row to the compact control bar.

## Consequences

A narrow composer shows less explanatory text, but preserves the warning’s presence, the complete explanation and both adjacent controls. Text length does not determine which control loses its space. This presentation decision does not supersede the router’s model-selection or idle-state rules.

## Verification

- [Routing chip component tests](../../../../packages/client/ui-model-routing/tests/routing-chip.client.spec.tsx) cover both idle reasons, action failures, full description relationships and independent IDs across simultaneous chips.
- [Built-Web composer tests](../../../../apps/web/tests/routing-chip-fit.e2e.ts) check both idle variants at wide and narrow widths, control separation, ellipsis space, tooltips and the linked full descriptions.
