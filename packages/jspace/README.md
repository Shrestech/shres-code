# jspace/ — Settings-toggled J-Space card

Logged five-line J-Space card the host remounts from a Settings allow switch. The card is session state, not a skill.

NOTICE: Protocol and card design is derived from Tiger3807861189 J-Space Cognition Suite V3.6 (Apache-2.0, DOI 10.5281/zenodo.21971181). This seat does not vendor their SKILL.md.

| Package | Role | ctx key |
|---|---|---|
| [`jspace/`](jspace/README.md) | Seat, settings namespace, remount, fold, session events | `ctx.jspace` |
| [`jspace-prompt/`](jspace-prompt/README.md) | Reprints the card as `jspace:card` | — |
| [`tool-jspace/`](tool-jspace/README.md) | Four model tools; remounts from `status.active` | — |
| [`command-jspace/`](command-jspace/README.md) | `/j-space on\|off`; session-local | — |

Design: [J-Space as a Settings-toggled harness card](../../.agents/notes/implemented/feature/2026-08-18-jspace-settings-toggle.md).
