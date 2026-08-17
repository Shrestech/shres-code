/**
 * Shared process lifecycle for the generic and closed-runtime JSON-RPC bins.
 *
 * @module @shres-code/shres-code-sdk-jsonrpc-demo/runner
 */

import { boot, installFailLoud, loadLayeredEnv } from '@shres-code/shres-code-app-boot'
import { resolveDemoConfig, selectExplicitConfigPath } from './resolveDemoConfig.ts'

/* v8 ignore start -- composition over tested app-boot/jsonrpc and executable acceptance paths */
const NAME = 'shres-jsonrpc-agent'

/**
 * Boot the explicitly selected external configuration and own process exit.
 * @param bareModuleBaseUrl - optional installed-runtime base for bare plugins;
 * omit it when the configuration project owns its plugin packages.
 * @returns after process handlers are installed; process lifetime then belongs
 * to stdin and signal events.
 */
export async function runJsonrpcAgent(bareModuleBaseUrl?: string): Promise<void> {
  installFailLoud(NAME)
  loadLayeredEnv(NAME)

  // Env wins over argv; empty values are absent. External config defines the deployment.
  const requested = selectExplicitConfigPath()
  if (requested === undefined) {
    process.stderr.write(
      `usage: ${NAME} <path/to/cordis.yml> (or set SHRES_CORDIS_CONFIG=<path>, which wins); the config is required — there is no built-in fallback\n`,
    )
    process.exit(1)
  }
  const configPath = resolveDemoConfig({ requested, binName: NAME })

  const ctx = await boot(NAME, configPath, undefined, undefined, bareModuleBaseUrl)
  let exiting = false

  async function disposeAndExit(code: number): Promise<void> {
    if (exiting) return
    exiting = true
    try {
      await ctx.fiber.dispose()
    } finally {
      process.exit(code)
    }
  }

  process.stdin.on('end', () => { void disposeAndExit(0) })
  process.on('SIGTERM', () => { void disposeAndExit(0) })
  process.on('SIGINT', () => { void disposeAndExit(130) })
}
/* v8 ignore stop */
