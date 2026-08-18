/** `goal` namespace dictionaries. */

/** English dictionary, the key-set source of truth. */
export const en = {
  'phase.active': 'Ongoing Goal',
  'phase.paused': 'Paused Goal',
  'phase.blocked': 'Blocked Goal',
  'objective.aria': 'Goal objective',
  'commandInput.aria': 'Command input',
  'action.save': 'Save goal',
  'action.cancel': 'Cancel edit',
  'action.pause': 'Pause goal',
  'action.resume': 'Resume goal',
  'action.edit': 'Edit goal',
  'action.clear': 'Clear goal',
  'game.mode': 'Game',
  'game.on': 'Turn Game mode on',
  'game.off': 'Turn Game mode off',
} satisfies Record<string, string>

/** The GoalKey union. */
export type GoalKey = keyof typeof en
