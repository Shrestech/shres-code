/**
 * Assembled-app regression: `team_list` is mounted on an ordinary root, lists
 * the implicit Lead, and does not treat a generic hire as a teammate.
 * `team_send` to a bound Aegis seat provisions then returns mailbox status.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeSessionLog, scrubRequestHeaders, type NormalizeContext } from '@shres-code/shres-code-acp-snapshot'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@shres-code/shres-code-loader-smoke'
import { describe, expect, it } from 'vitest'

const fixtureDir = fileURLToPath(new URL('./team-tools-snapshots/team-list', import.meta.url))
const replayOverride = join(fixtureDir, 'replay.override.json')
const parentExpected = join(fixtureDir, 'parent.expected.jsonl')
const configPath = fileURLToPath(new URL('../team-tools.cordis.snapshot.yml', import.meta.url))
const binScript = fileURLToPath(new URL('./fixtures/headless-driver.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const refreshing = process.env.SHRES_SNAPSHOT === 'refresh'
const task = 'Call team_list once and report the member names, then stop.'

describe('team_list headless snapshot', () => {
  it('lists the implicit Lead through the assembled headless app', async () => {
    let cwd = ''
    const result = await runLoaderSmoke({
      label: 'team_list headless stream-json snapshot',
      tempDirPrefix: 'shres-team-tools-',
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [configPath, task],
      tsconfigPath,
      env: {
        SHRES_SNAPSHOT_FILE: replayOverride,
        SHRES_SNAPSHOT_OVERRIDE: replayOverride,
      },
      prepare: (runCwd) => { cwd = runCwd },
      inspect: async (runCwd) => {
        const sessionsDir = join(runCwd, '.sessions')
        let files: string[] = []
        try {
          files = (await readdir(sessionsDir, { recursive: true })).filter(file => file.endsWith('.jsonl'))
        } catch {
          files = (await readdir(runCwd, { recursive: true })).filter(file => file.endsWith('.jsonl'))
        }
        const logs = await Promise.all(files.map(async file => ({
          file,
          content: await readFile(join(sessionsDir, file), 'utf8'),
        })))
        if (logs.length === 0) throw new Error(`no persisted session logs under ${sessionsDir}`)
        const parent = logs.find(log => log.content.includes('team_list'))?.content
          ?? logs[0]?.content
        if (parent === undefined) throw new Error(`missing persisted lead log in ${files.join(', ')}`)
        expect(parent).toContain('"name":"team_list"')
        expect(parent).toContain('you are lead; members: lead')
        expect(parent).not.toContain('"name":"subagent"')

        const header = parent.split('\n').find(line => line.trim().startsWith('{'))
        const sessionId = header !== undefined
          ? (JSON.parse(header) as { id?: string }).id ?? 'team-lead'
          : 'team-lead'
        const context: NormalizeContext = { sessionIds: [sessionId], cwd }
        const normalizedParent = scrubRequestHeaders(normalizeSessionLog(parent, context))
        if (refreshing) await writeFile(parentExpected, normalizedParent)
        expect(normalizedParent).toBe(await readFile(parentExpected, 'utf8'))
      },
    })

    expect(result.stderr).toBe('')
    const records = result.stdout.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(records.at(-1)).toMatchObject({
      output: 'TEAM_LIST_OK lead only',
    })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})

const sendFixtureDir = fileURLToPath(new URL('./team-tools-snapshots/team-send', import.meta.url))
const sendReplayOverride = join(sendFixtureDir, 'replay.override.json')
const sendParentExpected = join(sendFixtureDir, 'parent.expected.jsonl')
const sendConfigPath = fileURLToPath(new URL('../team-send.cordis.snapshot.yml', import.meta.url))
const sendTask = 'Call team_send to aegis with a short design prompt, report the mailbox status, then stop.'

describe('team_send headless snapshot', () => {
  it('provisions Aegis through Team mail and returns mailbox status', async () => {
    let cwd = ''
    const result = await runLoaderSmoke({
      label: 'team_send headless stream-json snapshot',
      tempDirPrefix: 'shres-team-send-',
      binScript,
      libBinScript: binScript,
      configPath: sendConfigPath,
      binArgs: [sendConfigPath, sendTask],
      tsconfigPath,
      env: {
        SHRES_SNAPSHOT_FILE: sendReplayOverride,
        SHRES_SNAPSHOT_OVERRIDE: sendReplayOverride,
      },
      prepare: async (runCwd) => {
        cwd = runCwd
        await mkdir(join(runCwd, '.shres'), { recursive: true })
        await writeFile(join(runCwd, '.shres', 'settings.yaml'), [
          'agent-seats:',
          '  seats:',
          '    aegis:',
          '      provider: deepseek-official',
          '      model: deepseek-v4-flash',
          '',
        ].join('\n'))
      },
      inspect: async (runCwd) => {
        const sessionsDir = join(runCwd, '.sessions')
        let files: string[] = []
        try {
          files = (await readdir(sessionsDir, { recursive: true })).filter(file => file.endsWith('.jsonl'))
        } catch {
          files = (await readdir(runCwd, { recursive: true })).filter(file => file.endsWith('.jsonl'))
        }
        const logs = await Promise.all(files.map(async file => ({
          file,
          content: await readFile(join(sessionsDir, file), 'utf8'),
        })))
        if (logs.length === 0) throw new Error(`no persisted session logs under ${sessionsDir}`)
        const parent = logs.find(log => log.content.includes('team_send'))?.content
          ?? logs[0]?.content
        if (parent === undefined) throw new Error(`missing persisted lead log in ${files.join(', ')}`)
        expect(parent).toContain('"name":"team_send"')
        expect(parent).toMatch(/team message .* (accepted|queued) for aegis/)
        expect(parent).not.toContain('"isError":true')

        const header = parent.split('\n').find(line => line.trim().startsWith('{'))
        const sessionId = header !== undefined
          ? (JSON.parse(header) as { id?: string }).id ?? 'team-lead'
          : 'team-lead'
        const context: NormalizeContext = { sessionIds: [sessionId], cwd }
        const normalizedParent = scrubRequestHeaders(normalizeSessionLog(parent, context))
        if (refreshing) await writeFile(sendParentExpected, normalizedParent)
        expect(normalizedParent).toBe(await readFile(sendParentExpected, 'utf8'))
      },
    })

    expect(result.stderr).toBe('')
    const records = result.stdout.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(records.at(-1)).toMatchObject({
      output: 'TEAM_SEND_OK accepted',
    })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})

const teammateFixtureDir = fileURLToPath(new URL('./team-tools-snapshots/team-send-teammate', import.meta.url))
const teammatePolicyExpected = join(teammateFixtureDir, 'teammate-policy.expected.md')
const teammateConfigPath = fileURLToPath(new URL('../team-send-teammate.cordis.snapshot.yml', import.meta.url))
const teammateTask = 'Send the retry-policy design task to aegis, then answer once the teammate settles.'
const TEAM_POLICY_MARKER = 'You are an Agent Team teammate named'

describe('team_send teammate headless snapshot', () => {
  it('provisions a teammate whose assembled prompt carries the policy', async () => {
    let cwd = ''
    const result = await runLoaderSmoke({
      label: 'team_send teammate headless stream-json snapshot',
      tempDirPrefix: 'shres-team-send-teammate-',
      binScript,
      libBinScript: binScript,
      configPath: teammateConfigPath,
      binArgs: [teammateConfigPath, teammateTask],
      tsconfigPath,
      env: {
        SHRES_SNAPSHOT_FILE: join(teammateFixtureDir, 'session.jsonl'),
        SHRES_SNAPSHOT_CHILD_FILES: join(teammateFixtureDir, 'session.1.jsonl'),
      },
      prepare: async (runCwd) => {
        cwd = runCwd
        await mkdir(join(runCwd, '.shres'), { recursive: true })
        await writeFile(join(runCwd, '.shres', 'settings.yaml'), [
          'agent-seats:',
          '  seats:',
          '    aegis:',
          '      provider: deepseek-official',
          '      model: deepseek-v4-flash',
          '',
        ].join('\n'))
      },
      inspect: async (runCwd) => {
        const sessionsDir = join(runCwd, '.sessions')
        let files: string[] = []
        try {
          files = (await readdir(sessionsDir, { recursive: true })).filter(file => file.endsWith('.jsonl'))
        } catch {
          files = (await readdir(runCwd, { recursive: true })).filter(file => file.endsWith('.jsonl'))
        }
        const logs = await Promise.all(files.map(async file => ({
          file,
          content: await readFile(join(sessionsDir, file), 'utf8'),
        })))
        const headerOf = (content: string): Record<string, unknown> =>
          JSON.parse(content.split('\n')[0] ?? '{}') as Record<string, unknown>
        const recordsOf = (content: string): Record<string, unknown>[] =>
          content.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)

        const lead = logs.find(log => typeof headerOf(log.content).parentSession !== 'string')
        const teammate = logs.find(log => typeof headerOf(log.content).parentSession === 'string')
        if (lead === undefined || teammate === undefined) {
          throw new Error(`missing persisted Lead or teammate log in ${files.join(', ')}`)
        }
        const leadRecords = recordsOf(lead.content)
        expect(leadRecords.filter(record => record.type === 'turn/start')).toHaveLength(1)
        expect(leadRecords.filter(record => record.type === 'turn/end')).toHaveLength(1)
        const notices = leadRecords.flatMap((record, index) => {
          if (record.type !== 'user/message') return []
          const source = (record.data as Record<string, unknown> | undefined)?.source as Record<string, unknown> | undefined
          return source?.kind === 'subagent-settled' ? [index] : []
        })
        expect(notices).toHaveLength(1)
        const steps = leadRecords.flatMap((record) => {
          if (record.type !== 'step/start') return []
          const data = record.data as { turn: number; step: number } | undefined
          return data === undefined ? [] : [`${data.turn}/${data.step}`]
        })
        expect(steps).toEqual(['1/1', '1/2', '1/3'])
        const finalStepIndex = leadRecords.findLastIndex(record => record.type === 'step/start'
          && (record.data as { turn?: number; step?: number } | undefined)?.step === 3)
        expect(finalStepIndex).toBeGreaterThanOrEqual(0)
        expect(notices[0]!).toBeGreaterThan(finalStepIndex)

        const teammateRecords = recordsOf(teammate.content)
        expect(teammateRecords.flatMap((record) => {
          if (record.type !== 'step/start') return []
          const data = record.data as { turn: number; step: number } | undefined
          return data === undefined ? [] : [`${data.turn}/${data.step}`]
        })).toEqual(['1/1', '1/2'])
        expect(teammateRecords.filter(record => record.type === 'turn/end')).toHaveLength(1)

        const systems = teammateRecords.flatMap((record) => {
          if (record.type !== 'request/header') return []
          const header = (record.data as Record<string, unknown> | undefined)?.header as Record<string, unknown> | undefined
          return typeof header?.system === 'string' ? [header.system] : []
        })
        const system = systems[0]
        if (system === undefined) throw new Error('teammate log has no request/header system prompt')
        const start = system.indexOf(TEAM_POLICY_MARKER)
        if (start === -1) throw new Error(`teammate system prompt is missing ${TEAM_POLICY_MARKER}`)
        // System sections join on a blank line; bound the section so a later one cannot leak in.
        const separator = system.indexOf('\n\n', start)
        const paragraph = system.slice(start, separator === -1 ? undefined : separator)
          .trimEnd().split(cwd).join('{{cwd}}')
        if (refreshing) await writeFile(teammatePolicyExpected, `${paragraph}\n`)
        expect(`${paragraph}\n`).toBe(await readFile(teammatePolicyExpected, 'utf8'))
      },
    })

    expect(result.stderr).toBe('')
    const records = result.stdout.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(records.at(-1)).toMatchObject({
      output: 'TEAM_SEND_TEAMMATE_OK',
    })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
