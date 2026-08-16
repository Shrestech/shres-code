#!/usr/bin/env node
/**
 * Boot an ACP stdio server from `cordis.yml`; usage is
 * `dsh-acp-demo [--config path]`. With no `--config`, the bin uses this
 * package's bundled composition path and never a CWD-relative `cordis.yml`.
 * Shared env loading, Loader guards, snapshot config selection, and settled-tree
 * boot live in dsh-app-boot. Replay skips `.env` and selects sibling
 * `cordis.snapshot.yml` so a stray key cannot trigger a model call. EOF disposes
 * and flushes snapshot runs; the calling automation owns process lifetime. Stdout is
 * reserved for JSON-RPC, so diagnostics go only to stderr.
 * @module @deepseek-ai/dsh-acp-demo/bin
 */

import { parseArgs } from 'node:util'
import { boot, installFailLoud, loadLayeredEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { bundledAcpDemoConfigPath, resolveDemoConfig } from './resolveDemoConfig.ts'

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
const chosen = resolveDemoConfig({
  requested: values.config,
  bundledDefault: bundledAcpDemoConfigPath(),
  binName: NAME,
})
const ctx = await boot(NAME, resolveConfigPath(chosen, snapshotMode))
if (snapshotMode !== undefined) {
  process.stdin.on('end', () => {
    void ctx.fiber.dispose().then(() => { process.exit(0) })
  })
}
/* v8 ignore stop */
