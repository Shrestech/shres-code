import { memo, useMemo } from 'react'
import type { PropsRenderSlots } from '@shres-code/shres-code-client-ui-slots'
import type {
  ChatRowViewingNodeProps, CommandRowOwnerProps,
} from '../contract/slots.ts'
import { chatRowViewingKey } from '../stores.ts'
import { CompactionCommandCard } from './CompactionCommandCard.tsx'
import { GenericCommandCard } from './GenericCommandCard.tsx'
import css from './ChatView.module.css'

type CommandNodeViewProps = ChatRowViewingNodeProps<'command'> & PropsRenderSlots<'conversation.chat.commandview'>

/** Ordinary command lifecycle renderer with command-name keyed specialization. */
export const CommandNodeView = memo(function CommandNodeView({ node, renderSlot, t, useStore, actions }: CommandNodeViewProps) {
  const command = node.data
  const owner = useMemo<CommandRowOwnerProps>(() => ({ node: command }), [command])
  const rowKey = chatRowViewingKey(node.key, 'command')
  const expanded = useStore(state => state.expanded[rowKey] === true)
  return (
    <div className={css.callRow}>
      {renderSlot('conversation.chat.commandview', owner, {
        entryKey: command.name ?? '',
        fallback: (
          <GenericCommandCard
            {...owner}
            t={t}
            expanded={expanded}
            onToggle={() => { actions.setExpanded(rowKey, !expanded) }}
          />
        ),
      })}
    </div>
  )
})

/** One integrated `/compact` command and compaction transaction renderer. */
export const ManualCompactionNodeView = memo(function ManualCompactionNodeView({
  node, t, useStore, actions,
}: ChatRowViewingNodeProps<'manual-compaction'>) {
  const data = node.data
  const rowKey = chatRowViewingKey(node.key, 'manual-compaction')
  const expanded = useStore(state => state.expanded[rowKey] === true)
  return (
    <div className={css.callRow}>
      <CompactionCommandCard
        node={data.command}
        {...data.compaction === null ? {} : { compaction: data.compaction }}
        t={t}
        expanded={expanded}
        onToggle={() => { actions.setExpanded(rowKey, !expanded) }}
      />
    </div>
  )
})
