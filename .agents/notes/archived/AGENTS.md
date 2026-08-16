# AGENTS.md — Archived Agent Notes

Archived Agent Notes under the kind directories are frozen historical snapshots, not current authority. Never edit, reformat, repair, delete, or move a sealed artifact; use an active Agent Note or current documentation for new decisions and facts.

On 2026-08-16 the owner sanctioned a one-time archive rebase: the English-only purge deleted every archived Chinese counterpart and pairing sidecar, then `verify-archived-agent-notes --rebase` re-sealed the surviving English files. After that rebase the boundary is frozen again. Do not use `--rebase` for any later change.

The archival change may only relocate a complete English note, insert the identical `Archived: YYYY-MM-DD` line below `Status: implemented`, and repair or delete inbound links. Do not inspect, verify, or repair links out of archived notes. Frozen English notes keep the historical `English | [中文](...)` switcher line; that line is not a live link.

Run the [`roos-archive-agent-notes`](../../skills/roos-archive-agent-notes/SKILL.md) workflow and append new artifact hashes with `pnpm run verify-archived-agent-notes --write`. The normal verifier rejects changed or missing sealed artifacts, unknown kind folders, leftover Chinese archive files, and invalid archive metadata.
