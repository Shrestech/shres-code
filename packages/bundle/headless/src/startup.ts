/**
 * The one-shot app's command-line provider: it parses the task positional and
 * `--help`, then publishes {@link HEADLESS_STARTUP_SERVICE}. The runner is an
 * ordinary consumer whose lazy config waits for that service.
 * @module @shres-code/shres-code-headless/startup
 */

import { Command } from 'commander'
import type { Context } from '@shres-code/cordis'
import { parseCmdline } from '@shres-code/shres-code-cmdline'
import { SessionId } from '@shres-code/shres-code-session'

/** Stable Cordis plugin name. */
export const name = 'headless-startup'

/** Services required before the task can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this plugin and injected by the one-shot runner. */
export const HEADLESS_STARTUP_SERVICE = 'headlessStartup'

/** What the runner row reads from {@link HEADLESS_STARTUP_SERVICE}. */
export interface HeadlessStartupValues {
  /** The task text this invocation asked for. */
  task: string
  /** Explicit id for the fresh session this invocation creates; absent means a generated id. */
  sessionId?: SessionId
  /** Persisted session id this invocation continues; absent means a fresh session. */
  resume?: SessionId
}

/**
 * This app's command: the task positional, its description, and its help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function headlessCommand(): Command {
  return new Command()
    .name('shres --profile headless')
    .description('Answer one task, print the final assistant message, and exit.')
    .helpOption('-h, --help', 'show this help')
    .argument('[task...]', 'the task text; multiple words are joined by spaces')
    .option('--session-id <id>', "create this invocation's fresh session under the given id")
    .option('--resume <id>', 'continue the persisted session with the given id')
    .addHelpText('after', `
Examples:
  shres --profile headless "run the tests"                      answer one task and exit
  shres --profile headless --session-id my-id "run the tests"   answer under a chosen session id
  shres --profile headless --resume my-id "keep going"          continue a persisted session
`)
}

/**
 * Parse and provide the one-shot task as an ordinary Cordis service. The
 * command's action publishes the task; a missing or whitespace-only task is a
 * usage error, so on rejection (and on `--help`) nothing is provided.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = headlessCommand()
  program.action(() => {
    const options = program.opts() as { sessionId?: string; resume?: string }
    if (options.sessionId !== undefined && options.resume !== undefined) {
      program.error('error: --session-id and --resume are mutually exclusive')
    }
    const task = program.args.join(' ')
    if (task.trim() === '') program.error('error: a task is required, for example: shres --profile headless "run the tests"')
    ctx.provide(HEADLESS_STARTUP_SERVICE, {
      task,
      ...options.sessionId === undefined ? {} : { sessionId: SessionId(options.sessionId) },
      ...options.resume === undefined ? {} : { resume: SessionId(options.resume) },
    } satisfies HeadlessStartupValues)
  })
  parseCmdline(ctx, program)
}
