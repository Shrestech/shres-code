/**
 * Sidebar slot contract: the registrant-side props composition for the
 * layout-owned `sidebar` slot, plus the holes this shell declares. The shell
 * owns column geometry (fold state machine, brand row, New Session);
 * `sidebar.remotes` (ui-remote) stacks the remote-host group above the
 * browsing region, everything below it is the `sidebar.workspaces`
 * registrant's (ui-workspace), and the foot is the `sidebar.footer.action`
 * registrant's (ui-settings), followed by optional footer actions in
 * `sidebar.footer.action`.
 */
import type { PropsLocale, PropsRenderSlots, PropsRuntime } from '@shres-code/shres-code-client-ui-slots'
// Type-only: pulls ui-layout's SlotMap merge (the 'sidebar' entry) into every
// program that sees this contract, so PropsRuntime<'sidebar'> resolves.
import type {} from '@shres-code/shres-code-client-ui-layout/client'
import type { WorkspaceId } from '@shres-code/shres-code-client-runtime/client'

declare module '@shres-code/shres-code-client-ui-slots' {
  interface SlotMap {
    /**
     * The remote-host group: one row per registry alias (alias, user@host,
     * status dot), the connected badge, and the add form. Declared by this
     * package's 'sidebar' entry; ui-remote registers the group.
     */
    'sidebar.remotes': { kind: 'single'; scope: 'root'; owner: SidebarSectionOwnerProps }
    /**
     * The workspace/session browsing region: section header, search, Pinned
     * and Running shortcut lists, the grouped/flat session list, and every
     * workspace dialog. Declared by this package's 'sidebar' entry (declaring
     * is claiming); ui-workspace registers the browser.
     */
    'sidebar.workspaces': { kind: 'single'; scope: 'root'; owner: SidebarSectionOwnerProps }
    /**
     * Optional actions beside Settings at the sidebar foot. Declared by this
     * package's 'sidebar' entry; each action receives only the column state.
     */
    'sidebar.footer.action': { kind: 'list'; scope: 'root'; owner: SidebarFooterActionOwnerProps }
    /**
     * Optional controls beside the product wordmark (wide logo row only).
     * Declared by this package's 'sidebar' entry; each action receives the
     * column state.
     */
    'sidebar.brand.action': { kind: 'list'; scope: 'root'; owner: SidebarBrandActionOwnerProps }
  }
}

/**
 * Owner share of the browser hole — the only facts crossing the shell/region
 * boundary. Business data and actions arrive through the region's own inject.
 */
export interface SidebarSectionOwnerProps {
  /** Shell fold-state output: wide renders the full browser, rail the icon column. */
  wide: boolean
  /** Rail icons request expansion; the browser rides the wide flip for focus. */
  expandSidebar: () => void
}

/** Owner share of an action rendered beside Settings at the sidebar foot. */
export interface SidebarFooterActionOwnerProps {
  /** Whether the sidebar renders wide content (false = 56px rail). */
  wide: boolean
}

/** Owner share of a control rendered beside the wordmark. */
export interface SidebarBrandActionOwnerProps {
  /** Whether the sidebar renders wide content (false = 56px rail). */
  wide: boolean
}

/**
 * Registrant-private injected share (arrives via the register inject
 * factory). The shell keeps only its own controls: starting a Session from
 * the New Session button and toggling the column.
 */
export type SidebarRootInjected = {
  /**
   * Start a New Session: with a workspace, reuse-or-create its blank session
   * and open it; without one, inherit the current Session Workspace, then the
   * recent Workspace, or clear into the New Session pure view when none exist.
   */
  startSession: (workspaceId?: WorkspaceId) => void
  /** Toggle the sidebar column through the layout service. */
  toggleSidebar: () => void
}

/**
 * Full component props: layout owner state/actions plus the declared holes'
 * render shares, this package's injected callbacks, and the standard locale
 * seat. No store is registered.
 */
export type SidebarRootComponentProps =
  PropsRuntime<'sidebar'>
  & PropsRenderSlots<'sidebar.remotes' | 'sidebar.workspaces' | 'sidebar.footer.action' | 'sidebar.brand.action'>
  & SidebarRootInjected & PropsLocale<'sidebar'>
