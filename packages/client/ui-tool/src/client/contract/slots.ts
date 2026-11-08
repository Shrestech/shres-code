/** Tool UI slot declarations and their composed component props. */
import type { PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore } from '@shres-code/shres-code-client-ui-slots'
import type { ToolCallBlock } from '@shres-code/shres-code-client-runtime/client'
import type {} from '@shres-code/shres-code-client-ui-conversation/client'
import type {} from '@shres-code/shres-code-client-locale/client'
import type { ToolDisclosureStore } from '../stores.ts'

declare module '@shres-code/shres-code-client-ui-slots' {
  interface SlotMap {
    /**
     * Keyed atomic Tool call view, dispatched by the wire Tool name. Register
     * with `key: '<tool name>'` to own how one tool's calls render inside a
     * turn — the key domain is open (any wire tool name, including a tool your
     * own package registered), so there is no compile-time key set to pick
     * from and a typo simply never renders.
     *
     * A key the shipped composition already covers is replaced, not shared;
     * an unclaimed key falls back to the generic tool row, so registering is
     * additive for your own tool and a takeover for a shipped one. The owner
     * passes the call's identity, frozen running-or-settled node, and
     * session-scoped disclosure state/update callback, so a renderer can
     * preserve disclosure while its virtualized row is unmounted.
     */
    'tool.call.toolview': { kind: 'keyed'; scope: 'session'; owner: ToolCallOwnerProps }
  }
}

/** Standard owner currency supplied to every atomic Tool view. */
export interface ToolCallOwnerProps {
  /** Tool call identity, stable across running and settled forms. */
  callId: string
  /** Wire Tool name and keyed dispatch value. */
  toolName: string
  /** Frozen running call or settled result node. */
  block: ToolCallBlock
  /** Session workspace root for relative summaries. */
  cwd?: string | undefined
  /** Open a Tool argument path through the Host. */
  openFile: (path: string) => void
  /** Inspect this call in the trajectory view when available. */
  inspect?: (() => void) | undefined
  /** Whether this call's expandable body is open in the session view. */
  expanded: boolean
  /** Update this call's session-scoped disclosure state. */
  onExpandedChange: (expanded: boolean) => void
}

/** Full props of a registered atomic Tool view. */
export type ToolCallViewProps = PropsRuntime<'tool.call.toolview'>

/** Full props of the Tool call-tree renderer registered as a `tool-call` Chat Node. */
export type ToolTreeProps = PropsRuntime<'conversation.chat.node', 'tool-call'>
  & PropsRenderSlots<'tool.call.toolview'>
  & PropsStore<ToolDisclosureStore>
  & PropsLocale<'conversation'>

/** Full props of the selected Tool output renderer in the details panel. */
export type ToolDetailsProps = PropsRuntime<'conversation.details.tool'> & PropsLocale<'conversation'>
