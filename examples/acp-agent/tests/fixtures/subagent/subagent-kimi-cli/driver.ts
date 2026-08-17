#!/usr/bin/env node
/** Inspect the public Kimi CLI provider composition without invoking the product. */

import { boot, resolveConfigPath } from '@shres-code/shres-code-app-boot'
import type {} from '@shres-code/shres-code-subagent'
import type {} from '@shres-code/shres-code-tools'

const configPath = process.argv[2]
if (configPath === undefined) {
  throw new Error('subagent-kimi-cli Loader composition driver requires a config path')
}

let starts = 0
const ctx = await boot(
  'subagent-kimi-cli-loader-composition',
  resolveConfigPath(configPath, undefined),
  undefined,
  (hostCtx) => {
    hostCtx.on('subagent/start', () => {
      starts += 1
    })
  },
)

try {
  const provider = ctx.subagents.getProvider('kimi-cli')
  if (provider === undefined) throw new Error('Kimi CLI provider was not registered')
  const tool = ctx.tools.schemas().find(schema => schema.name === 'subagent_kimi_cli')
  if (tool === undefined) throw new Error('subagent_kimi_cli tool was not registered')
  const properties = tool.parameters.properties
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    throw new Error('subagent_kimi_cli tool has invalid parameter properties')
  }

  process.stdout.write(`${JSON.stringify({
    providers: ctx.subagents.list(),
    provider: {
      name: provider.name,
      capabilities: provider.capabilities,
      inheritsParentContext: provider.inheritsParentContext,
    },
    tool: {
      name: tool.name,
      parameterNames: Object.keys(properties).sort(),
      required: tool.parameters.required,
    },
    starts,
  })}\n`)
} finally {
  await ctx.fiber.dispose()
}
