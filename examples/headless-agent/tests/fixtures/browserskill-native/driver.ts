/** Run the native BrowserSkill guide and not-ready commands through a real agent loop. */
import { boot } from '@shres-code/shres-code-app-boot'
import { runFixtureTurn } from '@shres-code/shres-code-loader-smoke'
import type {} from '@shres-code/shres-code-skill'

const config = process.argv[2]
if (config === undefined) throw new Error('Native BrowserSkill snapshot requires a Loader config')
const ctx = await boot('browserskill-native-snapshot', config)
try {
  const loggedToolEvents = new Set<string>()
  const result = await runFixtureTurn(ctx, {
    task: 'Load the browserskill guide and try its native browser session and navigation tools.',
    onEvent: (_sessionId, event) => {
      if (event.type.startsWith('tool/')) loggedToolEvents.add(event.type)
    },
  })
  const guide = (await ctx.skills.list()).find(skill => skill.name === 'browserskill')
  process.stdout.write(JSON.stringify({ kind: 'completed', output: result.output, source: guide?.source,
    loggedToolEvents: [...loggedToolEvents].sort() }) + String.fromCharCode(10))
} finally {
  await ctx.fiber.dispose()
}
