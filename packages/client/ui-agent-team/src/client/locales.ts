/** English copy for the Team roster panel. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'agent-team'

/** Every copy key the Team panel reads. */
export const en = {
  teamAction: 'Team',
  teamPanelTitle: 'Team roster',
  teamOpenConversation: 'Open conversation',
  teamEmpty: 'No teammates yet. Delegate to a seat to provision it.',
} as const

export type TeamKey = keyof typeof en
