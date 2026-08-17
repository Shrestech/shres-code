#!/usr/bin/env node
/**
 * Boot an ACP stdio server from an explicit `cordis.yml`; usage is
 * `shres-acp-demo --config path`. There is no CWD or built-in fallback.
 * Shared env loading, Loader guards, snapshot config selection, and settled-tree
 * boot live in shres-app-boot. Replay skips `.env` and selects sibling
 * `cordis.snapshot.yml` so a stray key cannot trigger a model call. EOF disposes
 * and flushes snapshot runs; the calling automation owns process lifetime. Stdout is
 * reserved for JSON-RPC, so diagnostics go only to stderr.
 * @module @shres-code/shres-code-acp-demo/bin
 */

import { parseArgs } from 'node:util'
import { boot, installFailLoud, loadLayeredEnv, resolveConfigPath } from '@shres-code/shres-code-app-boot'
import { resolveDemoConfig } from './resolveDemoConfig.ts'

const NAME = 'shres-acp-demo'

/* v8 ignore start -- thin self-executing composition over the unit-tested
   shres-app-boot helpers; exercised end-to-end by the snapshot suite and the
   built-bin smoke */
installFailLoud(NAME)
const snapshotMode = process.env['SHRES_SNAPSHOT']
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
