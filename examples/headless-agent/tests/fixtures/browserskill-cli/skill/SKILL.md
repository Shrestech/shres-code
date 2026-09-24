---
name: browser-skill
description: Drive the bsk browser CLI through documented session, navigate, and observe commands.
---

BROWSER_SKILL_GUIDE

The bsk CLI drives a browser automation session from the shell.

Documented command forms:

- `bsk --help` prints the command summary.
- `bsk session start --no-focus --json` starts a session without requesting browser focus; `--json` prints a JSON object whose `session_id` field names the new session.
- `bsk navigate URL --session SESSION_ID` points the session at one URL.
- `bsk observe --session SESSION_ID` prints the current page summary.
- `bsk session stop SESSION_ID` stops the session; the id is a positional argument, never a flag.

Any other argument shape is rejected with exit code 2 and a diagnostic on stderr.
Start the session first and pass its `session_id` to every later command.
Read references/forms.md only when the task needs additional detail.
