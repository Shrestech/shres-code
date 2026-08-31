# Agent Note: Quiet sidebar Remotes chrome

Status: implemented

## Problem

The Remotes group under the logo rendered as stacked outlined bars. The fold header, connect row, kebab, and Add remote control are native `<button>`s, and unlike the workspace list they never reset `border` or `background`, so the user-agent chrome (grey fill, 1px border) showed through. The kebab sat in its own box beside the row.

The connect UI is owned by [the sidebar Remotes group note](../feature/2026-08-30-remote-connect-sidebar.md); this note owns only the chrome.

## Decision

Those controls reset `appearance`, `border`, and `background` to transparent, matching the workspace browser's quiet rows. The header uses tertiary sentence-case like Workspaces. The kebab stays a descendant of the row, appears on hover, focus-within, or an open menu, and reports `aria-expanded`. Add remote is a ghost row, not a second outlined pill.

## Alternatives considered

**Leave native button chrome and restyle only the header.** Rejected: the row and Add remote used the same unreset buttons, so the stacked-bar look would remain.

**Replace the buttons with the primitives `Button`.** Rejected: that component's default is an elevated bordered control, which is the opposite of the workspace list.

**Always-visible kebab.** Rejected: workspace session rows surface trailing actions on hover; an always-on kebab reintroduces a second control box at rest.

## Consequences

A disconnected Remotes group reads as a list, not a stack of chips. The kebab is still in the accessibility tree at rest (opacity, not `display: none`), so keyboard and tests keep finding it.

## Testing

`packages/client/ui-remote/tests/components.client.spec.tsx` asserts the kebab shares the row parent with the connect button and toggles `aria-expanded`. The existing row/menu/add specs still drive the same roles.
