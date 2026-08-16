#!/usr/bin/env node
/**
 * Boot an ACP stdio server from an explicit `cordis.yml`; usage is
 * `dsh-acp-demo --config path`. There is no CWD or built-in fallback.
 * Shared env loading, Loader guards, snapshot config selection, and settled-tree
 * boot live in dsh-app-boot. Replay skips `.env` and selects sibling
 * `cordis.snapshot.yml` so a stray key cannot trigger a model call. EOF disposes
 * and flushes snapshot runs; the calling automation owns process lifetime. Stdout is
 * reserved for JSON-RPC, so diagnostics go only to stderr.
 * @module @deepseek-ai/dsh-acp-demo/bin
 */

import { parseArgs } from 'node:util'
import { boot, installFailLoud, loadLayeredEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { resolveDemoConfig } from './resolveDemoConfig.ts'

const NAME = 'dsh-acp-demo'

/* v8 ignore start -- thin self-executing composition over the unit-tested
   dsh-app-boot helpers; exercised end-to-end by the snapshot suite and the
   built-bin smoke */
installFailLoud(NAME)
const snapshotMode = process.env['DSH_SNAPSHOT']
if (snapshotMode !== 'replay') loadLayeredEnv(NAME)
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { config: { type: 'string', short: 'c' } },
  strict: true,
})
if (values.config === undefined || values.config === '') {
  process.stderr.write(
    `usage: ${NAME} --config <path/to/cordis.yml> (or -c); the config is required — there is no working-directory or built-in fallback\n`,
  )
  process.exit(1)
}
const chosen = resolveDemoConfig({ requested: values.config, binName: NAME })
const ctx = await boot(NAME, resolveConfigPath(chosen, snapshotMode))
if (snapshotMode !== undefined) {
  process.stdin.on('end', () => {
    void ctx.fiber.dispose().then(() => { process.exit(0) })
  })
}
/* v8 ignore stop */
