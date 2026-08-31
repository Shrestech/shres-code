# Agent Note: Details-pane image viewer

Status: implemented

## Problem

Clicking an image file path in the chat (for example the image_gen result `File: images/image-1.jpg`) opens the session details pane file viewer, which today renders only text. A binary read shows an explanatory note recommending the editor, so a generated image — the most common binary a session produces — is invisible in the pane. The host already serves the file's leading bytes over `host.readFile`; the gap is that the client neither knows the bytes are an image nor receives them for a binary read.

## Decision

Image file reads now render as images in the details pane, with the host carrying a sniffed media type on the `host.readFile` reply:

- The host sniffs a binary served slice's magic bytes (JPEG/PNG/WebP/GIF) — not the file extension — and, when it matches, adds two optional fields to the `FileRead` reply: `imageMediaType` (the sniffed type) and `imageData` (the served bytes as base64). The sniff runs only when the slice is binary, so the text path is untouched. A truncated image read still carries `imageMediaType` (so the viewer can show the image-specific cap note) but no `imageData`, because serving a partial image as an image corrupts. The wire change is additive: both fields are optional, and the zod schema accepts their absence.
- The client workspaces face passes the `FileRead` value through verbatim, so the type flows to the details panel without re-derivation.
- `DetailsPanel`'s file branch renders a recognized, non-truncated image read as a pane-bounded `<img>` (object-fit contain) from a `data:${imageMediaType};base64,${imageData}` URL, with the byte size and the browser-reported dimensions (`naturalWidth`/`naturalHeight` on load). A truncated image read shows a new note — the file exceeds the view cap; open it with the system or raise `fileViewMaxBytes` — with the size facts, and never renders a corrupt half image. Every other binary read keeps today's editor recommendation, and the text path is unchanged.

The default `fileViewMaxBytes` (512 × 1024) is not raised. Typical image_gen JPEGs (persist.ts writes JPEGs) can exceed that cap, so a large generated image commonly lands in the truncated-note arm rather than rendering; that interaction is documented in the apiproxy README and here, and raising the default is recorded as an alternative below.

## Alternatives considered

- **Serve the image through an attachments URL instead of the fenced read + data URL** — rejected. The attachments store is the durable image path for model-visible content, but a file-path click addresses an arbitrary workspace file, not a stored attachment; routing it through the attachment seam would require the host to materialize a transient attachment per read and would couple the file viewer to the attachment store's lifecycle. The fenced `host.readFile` already confines reads to workspace roots and serves the bytes; carrying them as base64 on the reply reuses that fence with no new surface.
- **Raise `fileViewMaxBytes` so typical image_gen JPEGs render** — rejected. The cap is a caller-visible gateway Config default; raising it changes how much of every file (text included) crosses the wire and is a deployment decision, not a viewer feature. The truncated-note arm already answers the "what is this file" question, and a deployment that wants larger images can raise the cap itself.
- **Trust the file extension instead of sniffing magic bytes** — rejected. An extension is cosmetic and can lie (a renamed or mislabeled file), and the host already has the bytes in hand; sniffing the slice's magic bytes is exact for the four supported formats and costs nothing. Extension trust would also mislabel a truncated or corrupt file as renderable.

## Consequences

Costs: a large generated image commonly shows the truncated-note arm at the default cap rather than rendering; base64 inflates the served slice by 1.33× (512 KiB becomes ~683 KiB) and, versus the pre-change empty-content binary reply, `imageData` is a straight addition of ~683 KiB on the wire; the sniff is a heuristic, so a binary slice that happens to start with image magic but is not a real image would render as a broken image (the browser's `onLoad` never fires and the meta line shows only the byte size).

Bought: generated images are visible in the details pane without leaving the app; the client renders the served bytes directly with no new host surface; truncated images degrade to an explicit note instead of a corrupt half image; and the wire change is additive, so older clients and the text path are unaffected.

## Testing

The host readFile spec pins the sniffed media type and base64 data for JPEG, PNG, WebP, and GIF slices, the absence of both for text and unknown-binary reads, and the type-without-bytes shape for a truncated image read. The DetailsPanel spec pins the `<img>` render with the data-URL source and byte size, the truncated-image note with size facts and no `<img>`, and the unchanged non-image binary note. The workspaces-service spec pins the type passing through the `readFile` face.

## Related

- [In-session file viewer pane](2026-08-30-in-session-file-viewer-pane.md) — the `host.readFile` fence, `fileViewMaxBytes` cap, and details-panel file branch this extends.
