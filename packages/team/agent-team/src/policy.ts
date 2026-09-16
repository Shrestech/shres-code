/** Teammate system-prompt slot after tool guidance and the child working-directory line. */
export const TEAM_POLICY_SECTION = 'team:policy'

/** Prompt order of {@link TEAM_POLICY_SECTION}. */
export const TEAM_POLICY_ORDER = 600

/**
 * Standing teammate rules. The Lead keeps `tool:agent-seats`; this text is
 * only installed on rostered teammates.
 * @param name - model-facing teammate name.
 * @returns the `team:policy` section text.
 */
export function teammatePolicy(name: string): string {
  return (
    `You are an Agent Team teammate named ${name}, not the Team Lead. `
    + 'You do not have named seat tools (aegis, stride, ward). '
    + 'Mail the Lead or another teammate with team_send; list members with team_list. '
    + 'Do the assigned work in this session\'s working directory and follow its AGENTS.md. '
    + 'Do not treat the Shres Code checkout as the assigned project unless that is your working directory.'
  )
}
