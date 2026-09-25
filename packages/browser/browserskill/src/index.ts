/** BrowserSkill runtime, management namespace, and model-tool plugin. */
import { join } from 'node:path'
import type { Context } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import type Schema from '@shres-code/schemastery'
import { resolveShresHome } from '@shres-code/shres-code-home-paths'
import type {} from 'zod'
import { resolveBrowserSkillConfig, type BrowserSkillConfigSpec } from './config.ts'
import { BrowserSkillGateway } from './gateway.ts'
import { BrowserSkillRuntime } from './runtime/supervisor.ts'
import { registerBrowserSkillGuide } from './skill.ts'
import { registerBrowserTools } from './tools.ts'

export { BrowserSkillGateway } from './gateway.ts'

/** Cordis plugin name. */
export const name = 'browserskill'
/** Registries that own the stable browser tools and guidance. */
export const inject = ['tools', 'skills']
/** Deployment values resolved before the runtime is constructed. */
export type Config = BrowserSkillConfigSpec
/** Loader validation; the runtime resolver owns deployment defaults. */
export const Config: Schema<Config> = z.object({
  artifactBaseUrl: z.string(),
  updateManifestUrl: z.string(),
  healthIntervalMs: z.number().step(1).min(1).max(2_147_483_647),
  healthMissLimit: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  commandTimeoutMs: z.number().step(1).min(8_000).max(2_147_483_647),
  daemonReadyTimeoutMs: z.number().step(1).min(1).max(2_147_483_647),
  browserConnectTimeoutMs: z.number().step(1).min(1).max(2_147_483_647),
  downloadTimeoutMs: z.number().step(1).min(1).max(2_147_483_647),
  maxDownloadBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
})

/**
 * Mount one home-owned runtime without downloading assets or opening Chrome.
 * @param ctx - plugin context with the tool and skill registries injected.
 * @param config - deployment values validated by the Loader.
 * @returns after stored provisioning state is read and contributions are mounted.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const runtime = new BrowserSkillRuntime({
    root: join(resolveShresHome(), 'browserskill'),
    config: resolveBrowserSkillConfig(config),
    logger: ctx.logger('browserskill'),
  })
  ctx.effect(() => () => runtime.dispose(), 'browserskill.runtime')
  await runtime.refreshProvisioned()
  new BrowserSkillGateway(ctx, runtime)
  registerBrowserTools(ctx, runtime)
  registerBrowserSkillGuide(ctx)
}
