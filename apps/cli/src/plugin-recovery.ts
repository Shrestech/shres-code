/** Recovery before expert profile commands can reconcile installed dependencies. */

import { nodePnpmRunner, withRecoveredProfile, resolveProfileDir } from '@shres-code/shres-code-app-boot'

/**
 * Recover an interrupted managed operation and retain its lock through the expert CLI command.
 * Signal listeners cover recovery only; the existing synchronous command owns its execution.
 * @param profile - the selected profile name.
 * @param run - the expert command, called only after recovery has settled.
 * @returns the command exit code, one on recovery failure, zero on SIGTERM, or 130 on SIGINT.
 */
export async function withProfilePluginRecovery(profile: string, run: () => number): Promise<number> {
  const controller = new AbortController()
  let interruptedCode = 0
  const terminate = (): void => { interruptedCode = 0; controller.abort() }
  const interrupt = (): void => { interruptedCode = 130; controller.abort() }
  process.once('SIGTERM', terminate)
  process.once('SIGINT', interrupt)
  const detachSignals = (): void => {
    process.off('SIGTERM', terminate)
    process.off('SIGINT', interrupt)
  }
  try {
    return await withRecoveredProfile(resolveProfileDir(profile), {
      runner: nodePnpmRunner,
      signal: controller.signal,
      invokingCwd: process.cwd(),
    }, (outcome) => {
      detachSignals()
      if (outcome.kind === 'recovered') process.stderr.write(JSON.stringify(outcome, null, 2) + '\n')
      return run()
    })
  } catch (error) {
    if (controller.signal.aborted) return interruptedCode
    process.stderr.write('shres: plugin recovery failed: ' + (error instanceof Error ? error.message : String(error)) + '\n')
    return 1
  } finally {
    detachSignals()
  }
}
