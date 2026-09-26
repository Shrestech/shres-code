/** Drive a real headless agent through browser-skill, bsk, and the real bash tool. */
import { readFile } from 'node:fs/promises'
import { boot } from '@shres-code/shres-code-app-boot'
import { runFixtureTurn } from '@shres-code/shres-code-loader-smoke'
import type {} from '@shres-code/shres-code-skill'

const config = process.argv[2]
if (config === undefined) throw new Error('browser-skill snapshot requires a Loader config')
const argvLogPath = process.env.BROWSERSKILL_ARGV_LOG
if (argvLogPath === undefined || argvLogPath === '') {
  throw new Error('browser-skill snapshot requires BROWSERSKILL_ARGV_LOG')
}
const ctx = await boot('browser-skill-snapshot', config)
try {
  const loggedToolEvents = new Set<string>()
  const result = await runFixtureTurn(ctx, {
    task: 'Use the browser-skill skill, then drive bsk for https://example.com and report completion.',
    onEvent: (_sessionId, event) => {
      if (event.type.startsWith('tool/')) loggedToolEvents.add(event.type)
    },
  })
  const summary = (await ctx.skills.list()).find(skill => skill.name === 'browser-skill')
  const argvLog = (await readFile(argvLogPath, 'utf8')).trim()
  process.stdout.write(JSON.stringify({
    kind: 'completed', output: result.output,
    source: summary?.source ?? null,
    loggedToolEvents: [...loggedToolEvents].sort(),
    bskArgv: argvLog.length === 0 ? [] : argvLog.split('\n').map(line => JSON.parse(line) as unknown),
  }) + '\n')
} finally {
  await ctx.fiber.dispose()
}
