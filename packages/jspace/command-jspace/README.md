# @shres-code/shres-code-command-jspace

Human-facing `/j-space` control over [`ctx.jspace`](../jspace/README.md). The plugin remounts from `watch()`: the command is unregistered while the seat is inactive. It never writes Settings `enabled`.

## Command contract

| Input | Result |
|---|---|
| `/j-space` | Show whether a card is open and the Goal/Next lines. |
| `/j-space on` | Open a card with the stock always-open lines `J-Space is on` / `State the first action`. If a card is already open, say so. |
| `/j-space on <goal> \| <next>` | Open a card with those lines. If a card is already open, say so. |
| `/j-space off` | Close the card, or say it is already closed. |

`on` and `off` are case-insensitive control words. Bare `on` uses the seat's `JSPACE_ALWAYS_OPEN_GOAL` / `JSPACE_ALWAYS_OPEN_NEXT`. `/j-space on only-goal` (no `|`) and an empty Goal or Next after `|` still return usage: `open a card with jspace_open or: /j-space on <goal> | <next>`.

## Composition

```yaml
- id: commands
  name: '@shres-code/shres-code-commands'
- id: jspace
  name: '@shres-code/shres-code-jspace'
  config:
    enabled: true
- id: command-jspace
  name: '@shres-code/shres-code-command-jspace'
```

## Model Experience

### Human `/j-space` control

#### What the model sees

The slash input, mutation, and direct status/error output are absent from model requests. The seat records an accepted open or close as `jspace/card` or `jspace/closed`. Presentation text is never logged as a model message.

#### Token effect

Reading status, opening or closing the card, or receiving a direct command error adds no model tokens.

#### KV Cache effect

Command discovery, mutations, and direct output do not affect the cache. Later requests follow the prompt Consumer's ordinary card reprint.

## Known Limitations and Deferred Work

- **Session-local only** — `/j-space off` closes the card; it does not write Settings `enabled`.
- **Bare `on` uses stock always-open lines** — `/j-space on` with no args opens with `J-Space is on` / `State the first action`, the same constants the prompt Consumer uses for `always-open`. `/j-space on only-goal` (no `|`) and an empty Goal or Next after `|` still return usage.
