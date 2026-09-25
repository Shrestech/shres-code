/** Local skill installation shared with the web host's management API. */

import {
  addInstalledSkill,
  defaultSkillInstallRoots,
  listInstalledSkills,
  removeInstalledSkill,
} from '@shres-code/shres-code-skill-filesystem/install'
import { assertNever } from '@shres-code/shres-code-llm'

/** Operations on Shres-managed skill copies, not arbitrary user skill directories. */
export type SkillCliCommand =
  | { kind: 'add'; directory: string }
  | { kind: 'list' }
  | { kind: 'remove'; name: string }

/**
 * Manage local skill copies without running their instructions or installing dependencies.
 * @param command - the parsed skill operation.
 * @returns zero on success, or one when refused or failed.
 */
export async function runSkillCli(command: SkillCliCommand): Promise<number> {
  try {
    const roots = defaultSkillInstallRoots(process.cwd())
    switch (command.kind) {
      case 'add': {
        const result = await addInstalledSkill(command.directory, roots)
        process.stdout.write(JSON.stringify(result, null, 2) + '\n')
        if (result.kind !== 'installed') return 1
        process.stderr.write('shres: skill copied as untrusted content; external programs and browser extensions are not installed\n')
        process.stderr.write('shres: filesystem name conflicts checked; runtime and bundled skills are not checked by this offline command\n')
        return 0
      }
      case 'list':
        process.stdout.write(JSON.stringify(await listInstalledSkills(roots), null, 2) + '\n')
        return 0
      case 'remove': {
        const result = await removeInstalledSkill(command.name, roots)
        process.stdout.write(JSON.stringify(result, null, 2) + '\n')
        return result.kind === 'removed' ? 0 : 1
      }
      default:
        return assertNever(command)
    }
  } catch (error) {
    process.stderr.write('shres: ' + (error instanceof Error ? error.message : String(error)) + '\n')
    return 1
  }
}
