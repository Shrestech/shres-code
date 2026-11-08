// CompactionCommandCard: the `/compact` command's running row and its
// successful checkpoint disclosure. Outcomes without a checkpoint keep the
// generic command card so no-history, cancellation, and failures retain their
// complete handler-authored text.

import type { ChatViewSlotProps, CommandRowOwnerProps } from '../contract/slots.ts'
import { CompactionItem } from './CompactionItem.tsx'
import { GenericCommandCard } from './GenericCommandCard.tsx'

interface CompactionCommandCardProps extends CommandRowOwnerProps {
  t: ChatViewSlotProps['t']
  expanded: boolean
  onToggle: () => void
}

/** Render one manual compaction lifecycle without duplicating its checkpoint marker. */
export function CompactionCommandCard({ node, compaction, t, expanded, onToggle }: CompactionCommandCardProps) {
  if (compaction !== undefined) {
    return (
      <CompactionItem
        node={compaction}
        title="compact"
        fallbackSummary={node.outcome?.text ?? null}
        t={t}
        expanded={expanded}
        onToggle={onToggle}
      />
    )
  }
  if (node.outcome !== null) return <GenericCommandCard node={node} t={t} expanded={expanded} onToggle={onToggle} />
  return <GenericCommandCard node={node} t={t} runningSummary={t('message.compaction.running')} expanded={expanded} onToggle={onToggle} />
}
