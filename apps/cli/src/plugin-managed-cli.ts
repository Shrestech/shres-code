/** Confirmed plugin installation and removal for one CLI-selected profile. */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { assertNever } from '@shres-code/shres-code-llm'
import {
  beginPluginInstall,
  DEFAULT_PROFILE_BUNDLES,
  healProfilesModuleFallback,
  initProfile,
  nodePnpmRunner,
  PROFILE_TEMPLATE_EDITIONS,
  PROFILE_TEMPLATES,
  removePlugin,
  resolveProfileDir,
  type ParkedInstall,
} from '@shres-code/shres-code-app-boot'

/**
 * This app's package.json, the installation anchor the shared profiles module
 * fallback mirrors (src/ and lib/ both sit one level under apps/cli).
 */
const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

/** A single managed operation; arbitrary pnpm arguments use the separate expert command. */
export interface PluginManagementCommand {
  kind: 'install' | 'remove'
  profile: string
  target: string
  yes: boolean
}

async function confirm(question: string, controller: AbortController): Promise<boolean> {
  const reader = createInterface({ input: process.stdin, output: process.stdout })
  const interrupt = (): void => { controller.abort(new Error('Confirmation interrupted')) }
  reader.once('close', interrupt)
  reader.once('SIGINT', interrupt)
  try {
    const answer = await reader.question(question + ' [y/N] ', { signal: controller.signal })
    return /^(?:y|yes)$/iu.test(answer.trim())
  } finally {
    reader.off('close', interrupt)
    reader.off('SIGINT', interrupt)
    reader.close()
  }
}

/**
 * Install or remove with explicit consent; non-interactive calls require --yes.
 * Confirmation rejection and interruption settle the owned install before returning.
 * @param command - one parsed operation and its selected profile.
 * @returns zero on success, or one when refused, cancelled, or failed.
 */
export async function runPluginManagementCli(command: PluginManagementCommand): Promise<number> {
  // Refuse before any profile initialization: the shared core refuses Windows
  // too, but only after this wrapper would already have created the profile.
  if (process.platform === 'win32') {
    process.stderr.write(JSON.stringify({ kind: 'refused', refusal: { code: 'unsupported-platform' } }, null, 2) + '\n')
    return 1
  }
  if (!command.yes && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    process.stderr.write('shres: plugin management requires an interactive terminal or explicit --yes consent\n')
    return 1
  }

  const controller = new AbortController()
  const interrupt = (): void => { controller.abort(new Error('Plugin management interrupted')) }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  let pending: ParkedInstall | undefined
  try {
    const profileDir = resolveProfileDir(command.profile)
    const options = { runner: nodePnpmRunner, signal: controller.signal, invokingCwd: process.cwd() }
    switch (command.kind) {
      case 'remove': {
        process.stdout.write(JSON.stringify({ profile: command.profile, remove: command.target }, null, 2) + '\n')
        if (!command.yes && !await confirm('Remove this plugin? Loaded copies remain active until restart.', controller)) return 1
        const result = await removePlugin(profileDir, command.target, options)
        process.stdout.write(JSON.stringify(result, null, 2) + '\n')
        if (result.kind !== 'removed' || result.pnpm !== 'ok') return 1
        process.stdout.write('shres: restart the profile to unload the removed plugin\n')
        return 0
      }
      case 'install': {
        // The consent-time composition check resolves in-box bundles through
        // the shared profiles fallback, which a fresh home has not healed yet.
        healProfilesModuleFallback(INSTALL_ANCHOR)
        if (!existsSync(join(profileDir, 'package.json'))) {
          initProfile(
            profileDir, PROFILE_TEMPLATES[command.profile] ?? DEFAULT_PROFILE_BUNDLES,
            PROFILE_TEMPLATE_EDITIONS[command.profile],
          )
        }
        const begun = await beginPluginInstall(profileDir, command.target, options)
        if (begun.kind === 'refused') {
          process.stderr.write(JSON.stringify(begun, null, 2) + '\n')
          return 1
        }
        pending = begun.install
        process.stdout.write(JSON.stringify(pending.preview, null, 2) + '\n')
        if (!command.yes && !await confirm('Enable this third-party plugin? Its code runs when this profile restarts.', controller)) {
          const rollback = await pending.cancel()
          pending = undefined
          process.stdout.write(JSON.stringify({ kind: 'cancelled', rollback }, null, 2) + '\n')
          return 1
        }
        const result = await pending.confirm()
        pending = undefined
        process.stdout.write(JSON.stringify(result, null, 2) + '\n')
        if (result.kind !== 'committed') return 1
        process.stdout.write('shres: restart the profile to activate the installed plugin\n')
        return 0
      }
      default:
        return assertNever(command.kind)
    }
  } catch (error) {
    process.stderr.write('shres: ' + (error instanceof Error ? error.message : String(error)) + '\n')
    return 1
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', interrupt)
    if (pending !== undefined) {
      try {
        const rollback = await pending.cancel()
        if (rollback.reinstall === 'failed') process.stderr.write(JSON.stringify(rollback, null, 2) + '\n')
      } catch (error) {
        process.stderr.write('shres: plugin rollback failed: ' + (error instanceof Error ? error.message : String(error)) + '\n')
      }
    }
  }
}
