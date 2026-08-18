# @shres-code/shres-code-client-ui-jspace

J-Space composer chip and dock strip. The browser half occupies `conversation.input.left` (after the resident access-mode and Plan chrome) with a session on/off chip, and `conversation.input.dock` at order 11 (after GoalBar) with the open-card strip. The node half is an empty apply (the roster row). Card state arrives through `useProjection('jspace')`; Settings `enabled` arrives through the bound `jspace` settings scope. The chip never writes that document.

The chip is hidden while Settings `enabled` is not true. While a card is open it renders the on-state "J-Space ×" control and executes `/j-space off` through `command.execute`. With no card it renders the off-state control and executes `/j-space on`; the host opens the stock card (Goal `J-Space is on`, Next `State the first action`). The dock strip is hidden when Settings is off or the projection card is null. It shows Goal and Next; when a live GoalBar already shows the same objective sentence the strip omits Goal and shows Core / Next / last Checked only.

Trajectory badges for `jspace/card` and `jspace/closed` attach onto existing Input / Model / Tools rows from the Trajectory plugin and do not rename those lanes.

## Model Experience

None, as browser UI.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Chip on opens the stock card** — bare `/j-space on` opens Goal `J-Space is on` and Next `State the first action`. Explicit `/j-space on <goal> | <next>` still sets both lines.
- **The chip belongs to the default composer** — a pending whole-composer interaction temporarily replaces the InputBar and its left-row chip.
- **Trajectory badges do not create rows** — open / checkpoint / closed attach onto an existing Input / Model / Tools record and never rename those lanes.
