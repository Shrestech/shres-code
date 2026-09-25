/**
 * The skill-name grammar as a dependency-free module. Offline consumers such
 * as the skill install helpers import it without loading the registry and
 * its Cordis runtime; the package root re-exports the same function.
 * @module @shres-code/shres-code-skill/name
 */

/** Kebab-case skill-name grammar shared by providers, runtime registration, and installers. */
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Return whether a string is a valid kebab-case skill name.
 * @param name - candidate skill name to validate.
 * @returns whether the name matches the public skill-name grammar.
 */
export function isSkillName(name: string): boolean {
  return SKILL_NAME.test(name)
}
