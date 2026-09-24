/** Drive a real headless agent and expose model-visible and logged skill evidence. */
import { boot } from '@shres-code/shres-code-app-boot'
import { runFixtureTurn } from '@shres-code/shres-code-loader-smoke'
import type {} from '@shres-code/shres-code-skill'

const config = process.argv[2]
if (config === undefined) throw new Error('installed-skill snapshot requires a Loader config')
const ctx = await boot('installed-skill-snapshot', config)
try {
  const loggedToolEvents = new Set<string>()
  const result = await runFixtureTurn(ctx, {
    task: 'Load installed-probe and report completion.',
    onEvent: (_sessionId, event) => {
      if (event.type.startsWith('tool/') && JSON.stringify(event).includes('INSTALLED_SKILL_GUIDE')) loggedToolEvents.add(event.type)
    },
  })
  const summary = (await ctx.skills.list()).find(skill => skill.name === 'installed-probe')
  process.stdout.write(JSON.stringify({
    kind: 'completed', output: result.output,
    source: summary?.source ?? null,
    loggedToolEvents: [...loggedToolEvents].sort(),
  }) + '\n')
} finally {
  await ctx.fiber.dispose()
}
