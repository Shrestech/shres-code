# Agent Note: In-session file viewer pane

Status: implemented

## Problem

Clicking a filesystem path in a tool row handed the file to the operating system's default application (`open`/`Invoke-Item`/`xdg-open`): the browser lost focus to Xcode or VS Code, the file's language or size didn't matter, and a read-only gesture became a context switch. The right-hand details panel already existed (`AppFrame`'s details column with its Tool-card seat) but had no entry point reachable from the transcript, and no wire method could fetch a file's content for such a pane — only directory listings and the native opener crossed that seam.

## Decision

File-path clicks now open the file **in the session's details pane**, and the host gained one fenced read method for it:

- `host.readFile` (apiproxy host domain) takes one absolute path. Admission is decided on the symlink-resolved real target: it must sit inside the gateway's host project cwd or a registered Workspace root, otherwise the request answers `file-outside-workspace` naming the real path; missing, directory, or otherwise unreadable targets answer `file-unreadable`. The reply is the first `fileViewMaxBytes` bytes (gateway `Config`, default 512 × 1024) with the physical `sizeBytes`, an in-band `truncated` flag, and a `binary` flag set when the served slice contains NUL bytes. It joins the `host.pickDirectory` loopback set in the browser carrier fence.
- The client workspaces face exposes `readFile(path)`, wrapping business errors in `FileReadError` like `openPath` does.
- The chat view's `openFile` inject face keeps native open only for directory gestures (the deliverables row's Show-folder chip, `path === '.'` or trailing `/`); every other path writes a `{ kind: 'file', path }` selection into the shared chat store and opens the layout pane. The persisted call-shaped selection target stays rehydratable.
- `DetailsPanel` grew the file branch: the injected `readFile` face fetches per selection (cwd-resolved in the apply world), `ReadBlock` renders the file's own line numbers with grammar highlighting, binary/truncated/empty reads render explanatory notes, a failed read shows the reason in-pane, and the header keeps an "Open in editor" chip over `openNative` so the native hand-off never disappears.

## Alternatives considered

- **Keep routing every file path to the OS** (the [tool-call file open in OS](2026-07-28-tool-call-file-open-in-os.md) decision) — rejected here: the user-visible goal moved to in-context reading; that note's native behavior survives for directory gestures and as the pane's fallback chip.
- **Serve file bytes without confinement** — rejected; a file-content RPC that any open page could point at arbitrary host paths turns a browser tab into a local-file exfiltration tool, so the fence is enforced in the operation that reads, not by the caller's trustworthiness.
- **A hard `file-too-large` refusal at the cap** — rejected; a partial first slice with `truncated` answers the "what is this file" question a refusal cannot, and in-band metadata keeps the wire shape total.
- **Client-side byte capping before the request** — rejected; only the host knows the physical size, and a client guard cannot keep an oversized read from being served.

## Consequences

Costs: large files read as previews (the cap is the design, configurable per deployment); the NUL sniff is a heuristic, so UTF-16 text reports as binary and recommends the editor; the pane's call half is reachable only through file-path rows, with no direct call-selection entry yet; the loopback pin means remote (non-loopback GUI) clients lose the viewer, matching `openPath`.

Bought: reading a session-touched file no longer leaves the app; content never leaves registered workspace roots; binary and oversized files degrade to explicit notes instead of garbage text or refusals; and the details panel gained its first organic entry point, so the raw selected-call display is now reachable from the transcript too (a file row selects the file and opens the pane).

## Testing

The fence suite pins cwd-root reads, a second registered root, symlink escapes, outside-absolute paths, missing/directory reads, NUL binary flags, cap truncation with exact-boundary behavior, pre-aborted cancellation, and the wire-form round trip; the LAN authority test pins `host.readFile` beside `openPath` at 403. The runtime suite pins the `FileReadError` wrap. Detail-panel specs cover every read arm, the store-riding selection swap with stale-drop, the native chip, and the close gesture; ui-tool click-flow specs pin the owner-to-pane handoff and the folder chip's native escape.

## Related

- [Tool-call file open in OS](2026-07-28-tool-call-file-open-in-os.md) — the native-open decision this reverses for file paths, and the loopback fence precedent `readFile` joins.
- [Web workspace file links](2026-07-31-web-workspace-file-links.md) — the produced-files surfaces whose directory gestures stay native.
- [Package tool presentation ownership](../architecture/2026-08-08-client-tool-presentation-ownership.md) — the details panel as the second Tool presentation point whose seat the file branch shares.
