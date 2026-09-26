# Agent Note: Dark state tertiary surfaces name the same static step as light

Status: implemented

## Problem

In the dark theme, `--dsw-alias-state-warn-tertiary` named `--dsw-static-amber-900`. The static scale in `packages/client/ui-theme/src/styles/design-platform.css` is already redefined under `body[data-ds-dark-theme]` so that step 100 is the low-emphasis end in both themes: dark `amber-100` is `#5a422b` and dark `amber-900` is `#f3d9b9`. Naming step 900 in dark inverted the scale a second time, so every warn surface painted light amber under the light dark-theme warn text. `--dsw-alias-state-warn-label` (`#e9b673`) on it measured 1.35:1 and `--dsw-alias-state-warn-primary` (`#e0a760`) measured 1.56:1.

Six consumers draw text on the surface:

- the Plan chip, `ui-plan` `PlanModeControl.module.css`, in warn-label;
- the Cordis panel's awaiting-approval and client-pending status pill, `ui-cordis` `CordisPanel.module.css`, in warn-label;
- Trajectory tool tags, `ui-trajectory` `TrajectoryCell.module.css` `.tagTool` and `.tagSubtool`, in warn-label and a mix of warn-label with label-tertiary;
- Trajectory tool rows, `ui-trajectory` `TrajectoryTable.module.css` `.toolAmber` and `.subtoolAmber`, in the same two colors;
- the approval strip, `ui-conversation` `ApprovalPanel.module.css`, in warn-primary;
- the plan-review strip, `ui-user-questions` `PlanReviewPanel.module.css`, in warn-primary.

## Decision

Dark `--dsw-alias-state-warn-tertiary` names `--dsw-static-amber-100`, the step light already names. The rule is that a semantic alias names the same static step in both themes, and every state tertiary surface is step 100; the [ui-theme README](../../../../packages/client/ui-theme/README.md) states it. The success and business tertiary aliases already followed it (`green-100` and `deepseek-100` in both themes), and the danger, error, and info families declare no tertiary alias.

In dark, warn-label on the surface now measures 5.07:1, which meets WCAG AA for normal text. The light theme is unchanged.

`packages/client/ui-theme/tests/state-surfaces.client.spec.ts` reads the sheet. For every state family that declares a tertiary surface, it asserts that the alias names the same static step in both themes and that the surface is darker than the family's text in dark. For every family with a label alias, it asserts that label text on the surface meets AA in dark. With the dark mapping set back to `amber-900`, the three warn cases fail.

## Alternatives considered

**Add a darker dark-only amber step.** Rejected: it adds a palette value only warn uses and breaks the same-step rule every other state tertiary follows.

**Move the approval and plan-review strip text from warn-primary to warn-label.** Not part of this change: in dark it raises the strips from 4.39:1 to 5.07:1, but it also changes the light strips, which this change keeps as they are.

## Consequences

- The approval and plan-review strips draw 13px text in warn-primary, which measures 4.39:1 on the dark surface. That is readable, but below AA for normal text; their text role is warn-label.
- In light, warn-label on warn-tertiary measures 3.76:1 and warn-primary measures 2.67:1. Both are below AA and are unchanged by this change.
- In dark, business-primary on business-tertiary, the routing chip's on state, measures 3.44:1.
- The routing warning surfaces use `--dsw-alias-fill-tsp-secondary` with a warn-secondary border instead of the tertiary surface, and are unchanged.
