# Agent Note: Sidebar Running and Pinned session lists

Status: implemented

## Problem

Workspace groups fold to five Session rows and can hide the rest behind **Show more**. A Session that is running, waiting for the user, or carrying a running subagent descendant can disappear from view when its group is closed or overflowed, so the user cannot jump back to live work without expanding every Workspace. There is also no way to keep a Session at the top of the sidebar after it goes idle.

## Decision

`ui-workspace` owns both shortcut lists inside the existing `sidebar.workspaces` browsing region. They stack above Workspace groups and above the flat list, in the same scroll region, and hide while empty.

**Running** is derived from the Session list: a visible ordinary Session appears there when it is running, a descendant reached through uninterrupted subagent-origin lineage is running, or `pendingInteraction` is set. Order is newest `updatedAt` first. Subagent-origin rows stay hidden; their activity still lifts the visible parent, matching the existing row status.

**Pinned** is a browser-local `pinnedSessionIds` array on the workspace view store (`shres.workspace.view.v5`). Pin prepends; Unpin removes. The Session-row menu exposes Pin / Unpin on non-blank rows. A live pinned Session appears only in Pinned so the two shortcut lists do not duplicate it. The Session remains in its Workspace group or the flat list. After a ready Session list, `retainPinnedSessions` drops archived and missing ids. A persist document without `pinnedSessionIds` is treated as an empty pin list; writers coerce that to `[]` rather than bumping the persist key.

Search replaces the whole browsing body, including both shortcut lists. The collapsed rail does not render the lists; expanding the sidebar is the route back.

## Alternatives considered

**Declare a new `sidebar.sessions` hole on the column shell.** Rejected: remotes earned their own hole because they are not Workspaces. Running and pinned Sessions are the same Session list `ui-workspace` already projects.

**Host-durable pins on the workspace registry.** Rejected: pin is a presentation preference like grouping, expansion, and Ungrouped order. A Host field would add RPC, frames, and a schema change for a browser-local shortcut.

**Move pinned Sessions out of their Workspace groups.** Rejected: membership and the shortcut are different questions. Removing the group row would hide which Workspace the Session belongs to and fight drag-reorder of that group's account.

**Running only, no pending-interaction rows.** Rejected: a Session waiting for approval, a plan review, or an answer is live work the user needs to find while its group is folded. The Running label stays because that is the in-flight list; waiting rows already use the amber status on the same row.

## Consequences

Finding live work does not depend on expanding the right Workspace. Pin does not survive across browsers or machines. Duplicate titles can appear once in a shortcut list and again in an expanded group; that is the shortcut, not a second Session. Collapsed groups still do not light a header indicator for waiting rows inside them.

## Testing

`tree.ts` pins Running membership (self, pending, descendant, pinned exclusion, archive, subagent-origin hide) and Pinned order (unknown, duplicate, blank, archive). The view store pins prepend/unpin, retain, and a missing persist field. Row and browser specs pin the menu, the folded-group Running list, Pin moving a live row out of Running, archive dropping the pin, and search hiding both lists. The keyless web e2e `apps/web/tests/sidebar-subagent-activity.e2e.ts` snapshots the Running group with a held descendant and the same owner after Pin.

## Related

- [Workspace Sidebar Order and Folding](2026-08-11-workspace-sidebar-order-and-folding.md) — the five-row fold this shortcut exists to see past.
- [Session archive](2026-07-31-session-archive-global-set.md) — archive still hides every grouping surface, including these lists.
