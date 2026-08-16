/**
 * First-run model picker. Detects local Ollama, decides whether a default
 * can already serve, and on a TTY prints a menu that writes
 * `agent-default-model` plus credentials. A non-TTY process with no usable
 * default fails loud; the service never silently selects a vendor.
 *
 * @module @roos-code/roos-code-first-run-setup
 */

import { Context, Service } from '@roos-code/cordis'
import z from '@roos-code/schemastery'
import { MAX_TIMER_DELAY_MS } from '@roos-code/roos-code-timeout'
import type {} from '@roos-code/roos-code-agent-default-model'
import type {} from '@roos-code/roos-code-llm'
import type {} from '@roos-code/roos-code-settings'
import type {} from '@roos-code/roos-code-credentials'
import { applyChoice } from './apply-choice.ts'
import { runCliPicker } from './cli.ts'
import { detectLocalOllama } from './detect.ts'
import { hasUserSelection, isDefaultUsable, listPickerOptions, TEMPLATE_ROUTES } from './options.ts'
import type { CliIo, FirstRunChoice, LocalOllamaStatus, PickerOption, TemplateRoute } from './types.ts'

export type {
  CliIo, FirstRunChoice, LocalOllamaStatus, PickerOption, TemplateRoute,
} from './types.ts'
export { detectLocalOllama } from './detect.ts'
export { applyChoice, deriveKeyRef } from './apply-choice.ts'
export { formatMenu, numberOptions, readLine, readSecret, runCliPicker } from './cli.ts'
export { hasUserSelection, isDefaultUsable, listPickerOptions, noProviderError, TEMPLATE_ROUTES } from './options.ts'

declare module '@roos-code/cordis' {
  interface Context {
    /** First-run model picker and local-Ollama probe. */
    firstRunSetup: FirstRunSetup
  }
}

/** Default local Ollama OpenAI-compatible base URL. */
export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434/v1'

/** Default probe timeout. */
export const DEFAULT_DETECT_TIMEOUT_MS = 1500

/** Plugin configuration. Timeouts and URLs that vary by deployment live here. */
export interface Config {
  /** OpenAI-compatible base URL used to probe local Ollama. */
  ollamaBaseURL: string
  /** Abort the local-Ollama GET after this many milliseconds. */
  detectTimeoutMs: number
  /**
   * When true, `apply` runs the CLI picker before the plugin is considered
   * mounted. Headless instead calls {@link FirstRunSetup.ensureReady} after
   * the loader settles so adapter routes exist first.
   */
  autoRunCli: boolean
}

/** Cordis plugin name. */
export const name = 'first-run-setup'

/** Services required before the picker can read a default or list routes. */
export const inject = ['agentDefaultModel', 'llm']

/** Validated plugin config after schema defaults. */
export interface FirstRunResolvedConfig {
  /** OpenAI-compatible base URL used to probe local Ollama. */
  ollamaBaseURL: string
  /** Abort the local-Ollama GET after this many milliseconds. */
  detectTimeoutMs: number
  /** Whether {@link apply} runs the CLI picker during mount. */
  autoRunCli: boolean
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  ollamaBaseURL: z.string().default(DEFAULT_OLLAMA_BASE_URL),
  detectTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_DETECT_TIMEOUT_MS),
  autoRunCli: z.boolean().default(false),
})

/**
 * Owns first-run detection and the CLI picker. Web onboarding reads the same
 * readiness rules from the Models join; this service is the host-side writer.
 */
export class FirstRunSetup extends Service {
  /** In-flight or completed local-Ollama probe shared by needsSetup and listOptions. */
  private probe: Promise<LocalOllamaStatus> | undefined

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'firstRunSetup')
  }

  /**
   * The resolved plugin config after schema defaults.
   * @returns a detached copy of the validated config.
   */
  resolvedConfig(): FirstRunResolvedConfig {
    return {
      ollamaBaseURL: this.config.ollamaBaseURL,
      detectTimeoutMs: this.config.detectTimeoutMs,
      autoRunCli: this.config.autoRunCli,
    }
  }

  /**
   * Probe local Ollama with this instance's configured URL and timeout.
   * @returns advertised models, or `reachable: false` when the endpoint is down.
   */
  detectLocalOllama(): Promise<LocalOllamaStatus> {
    this.probe = detectLocalOllama({
      baseURL: this.config.ollamaBaseURL,
      timeoutMs: this.config.detectTimeoutMs,
    })
    return this.probe
  }

  /** One probe per setup attempt; `listOptions` reuses `needsSetup`'s result. */
  private cachedProbe(): Promise<LocalOllamaStatus> {
    this.probe ??= detectLocalOllama({
      baseURL: this.config.ollamaBaseURL,
      timeoutMs: this.config.detectTimeoutMs,
    })
    return this.probe
  }

  /**
   * The shipped template routes the picker offers beside live Ollama models.
   * @returns the template list.
   */
  templateRoutes(): readonly TemplateRoute[] {
    return TEMPLATE_ROUTES
  }

  /**
   * Whether setup must run: no user-saved default, and the composition
   * default cannot serve.
   * @returns true when the CLI picker or web card should appear.
   */
  async needsSetup(): Promise<boolean> {
    if (hasUserSelection(this.ctx)) return false
    const selection = this.ctx.get('agentDefaultModel')?.currentSelection()
    // A non-Ollama default that already has its key does not need a probe.
    if (selection !== undefined && selection.provider !== 'ollama-local') {
      if (await isDefaultUsable(this.ctx, { reachable: false, models: [] })) return false
    }
    const ollama = await this.cachedProbe()
    return !(await isDefaultUsable(this.ctx, ollama))
  }

  /**
   * Menu entries for the current host: live Ollama models, templates, custom.
   * @returns picker options in print order.
   */
  async listOptions(): Promise<readonly PickerOption[]> {
    return listPickerOptions(await this.cachedProbe())
  }

  /**
   * Persist one picker outcome.
   * @param choice - the selected route, key, and model.
   */
  applyChoice(choice: FirstRunChoice): Promise<void> {
    return applyChoice(this.ctx, choice)
  }

  /**
   * Run the CLI picker when setup is required. A non-TTY process fails loud.
   * @param io - streams; omitted uses process stdin/stderr.
   */
  async ensureReady(io: CliIo = defaultIo()): Promise<void> {
    if (!(await this.needsSetup())) return
    const options = await this.listOptions()
    const choice = await runCliPicker(io, options)
    await this.applyChoice(choice)
  }
}

/** Process streams for a production CLI run. Prompts use stderr. */
export function defaultIo(): CliIo {
  return internals.io()
}

/** Production stdin/stderr pair; tests replace {@link internals.io}. */
export function processIo(): CliIo {
  return {
    stdin: process.stdin,
    stdout: process.stderr,
    stderr: process.stderr,
    /* v8 ignore next -- TTY detection is process-owned; tests assert both sides of the conjunction via the explicit CliIo. */
    isTTY: process.stdin.isTTY === true && process.stderr.isTTY === true,
  }
}

/**
 * Process-facing IO for {@link apply}'s `autoRunCli` path and {@link defaultIo}.
 * Tests replace `io` to drive `autoRunCli: true` without touching process.stdin.
 */
export const internals = {
  /** Factory for the CLI streams `apply` and {@link defaultIo} use. */
  io: processIo,
}

/**
 * Mount the first-run service. Optional `autoRunCli` runs the picker during
 * apply; headless instead calls `ensureReady` after the loader settles.
 * @param ctx - plugin context.
 * @param config - validated probe URL, timeout, and auto-run flag.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const setup = new FirstRunSetup(ctx, config)
  if (config.autoRunCli) await setup.ensureReady(internals.io())
}
