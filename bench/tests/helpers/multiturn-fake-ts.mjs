import { readFileSync } from 'node:fs'

// The fake harness bin source, loaded verbatim into the fake repo's bin.ts.
export const FAKE_BIN = readFileSync(new URL('./multiturn-fake-bin.mjs', import.meta.url), 'utf8')
export const FAKE_TSX_HOOKS = readFileSync(new URL('./multiturn-fake-tsx-hooks.mjs', import.meta.url), 'utf8')
