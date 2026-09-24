import { readFile, readdir } from 'node:fs/promises'
import { zstdDecompress } from 'node:zlib'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { cacheCount, promptTokens } from '@shres-code/shres-code-llm'
import type { TokenUsage } from '@shres-code/shres-code-llm'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@shres-code/shres-code-loader-smoke'
import type { SessionEvent } from '@shres-code/shres-code-session'

const binScript = fileURLToPath(new URL('./fixtures/headless-driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/cli.cordis.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const decompress = promisify(zstdDecompress)

describe('headless-agent keyless smoke', () => {
  it('boots the real Loader tree, runs a real bash tool round trip, and persists the turn', async () => {
    let persistedHeader: Record<string, unknown> | undefined
    const { stdout, stderr } = await runLoaderSmoke({
      label: 'headless-agent',
      tempDirPrefix: 'headless-agent-smoke-',
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [configPath, 'prove the tool path'],
      tsconfigPath,
      inspect: async (cwd) => {
        const files = await readdir(cwd, { recursive: true })
        const relativePath = files.find(file => file.endsWith('.jsonl.zstd'))
        if (relativePath === undefined) return
        const compressed = await readFile(join(cwd, relativePath))
        expect(compressed.subarray(0, 4).toString('hex')).toBe('28b52ffd')
        persistedHeader = JSON.parse((await decompress(compressed)).toString()) as Record<string, unknown>
      },
    })
    const lines = stdout.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    const events = lines.slice(0, -1).map(line => line['event'] as SessionEvent)
    const result = lines.at(-1)
    expect(stderr).toBe('')
    expect(events.some(event => event.type === 'tool/call' && event.data.name === 'bash')).toBe(true)
    const toolResult = events.find(event => event.type === 'tool/result')
    expect(JSON.stringify(toolResult)).toContain('CLI_TOOL_ROUND_TRIP')
    expect(result).toMatchObject({ type: 'result', usage: { outputTokens: 8, reasoningTokens: 1 } })
    // The mock reports a cache read on the tool step and none on the final step,
    // so the turn's aggregate cannot claim a measured read: both cache counts
    // stay absent and the reported read folds into the 20-token prompt.
    const usage = result?.['usage'] as TokenUsage
    expect(cacheCount(usage, 'read')).toBeUndefined()
    expect(cacheCount(usage, 'write')).toBeUndefined()
    expect(promptTokens(usage)).toBe(20)
    expect(String(result?.['output'])).toContain('CLI_TOOL_ROUND_TRIP')
    expect(persistedHeader).toMatchObject({ type: 'session' })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
