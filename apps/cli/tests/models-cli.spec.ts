/** `roos models` / `roos providers` against a temp $ROOS_HOME. */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { credentialRef } from '@roos-code/roos-code-credentials'
import {
  bootModelsCli,
  runModelsCli,
  type ModelsCliCommand,
  type ModelsCliIo,
} from '../src/models-cli.ts'

const homes: string[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'roos-models-cli-'))
  homes.push(home)
  return home
}

async function listingServer(payload: unknown): Promise<string> {
  const server = createServer((_request: IncomingMessage, response: ServerResponse) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(payload))
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return `http://127.0.0.1:${address.port}/v1`
}

function capture(script: string[] = []): { io: ModelsCliIo; stdout: () => string; stderr: () => string; code: () => number } {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let out = ''
  let err = ''
  let code = 0
  stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
  stderr.on('data', (chunk: Buffer) => { err += chunk.toString('utf8') })
  queueMicrotask(() => {
    for (const line of script) stdin.write(`${line}\n`)
    stdin.end()
  })
  return {
    io: {
      stdin, stdout, stderr,
      isTTY: true,
      exit: (next) => { code = next },
    },
    stdout: () => out,
    stderr: () => err,
    code: () => code,
  }
}

async function run(home: string, command: ModelsCliCommand, script: string[] = []) {
  const captured = capture(script)
  const exit = await runModelsCli(command, captured.io, home)
  return { exit, stdout: captured.stdout(), stderr: captured.stderr(), code: captured.code() }
}

describe('roos models / providers', () => {
  it('lists shipped providers and flags missing-key routes', async () => {
    const home = await tempHome()
    const result = await run(home, { kind: 'models-list' })
    expect(result.exit).toBe(0)
    expect(result.stdout).toContain('Default: deepseek-official deepseek-v4-flash')
    expect(result.stdout).toContain('deepseek-official')
    expect(result.stdout).toMatch(/unusable until keyed/)
    expect(result.stdout).toContain('ollama-local')
    expect(result.stdout).toContain('llama3.2')
  })

  it('sets the default including reasoning effort', async () => {
    const home = await tempHome()
    const set = await run(home, {
      kind: 'models-set',
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      effort: 'max',
    })
    expect(set.exit).toBe(0)
    expect(set.stdout).toContain('Default: deepseek-official deepseek-v4-pro effort=max')
    const listed = await run(home, { kind: 'models-list' })
    expect(listed.stdout).toContain('Default: deepseek-official deepseek-v4-pro effort=max')
    expect(listed.stdout).toContain('deepseek-v4-pro  (default)')
  })

  it('writes a purpose override without replacing the conversation default', async () => {
    const home = await tempHome()
    await run(home, {
      kind: 'models-set', provider: 'deepseek-official', model: 'deepseek-v4-flash',
    })
    const set = await run(home, {
      kind: 'models-set',
      provider: 'ollama-local',
      model: 'llama3.2',
      purpose: 'compaction',
    })
    expect(set.stdout).toContain('Purpose compaction: ollama-local llama3.2')
    const listed = await run(home, { kind: 'providers-list' })
    expect(listed.stdout).toContain('Default: deepseek-official deepseek-v4-flash')
    expect(listed.stdout).toContain('Purpose compaction: ollama-local llama3.2')
  })

  it('rejects an unknown provider and an unknown effort', async () => {
    const home = await tempHome()
    const missing = await run(home, {
      kind: 'models-set', provider: 'no-such', model: 'x',
    })
    expect(missing.exit).toBe(1)
    expect(missing.stderr).toMatch(/unknown provider "no-such"/)
    const effort = await run(home, {
      kind: 'models-set', provider: 'deepseek-official', model: 'deepseek-v4-flash', effort: 'nope',
    })
    expect(effort.exit).toBe(1)
    expect(effort.stderr).toMatch(/does not support reasoning effort "nope"/)
  })

  it('discovers models and optionally appends them', async () => {
    const home = await tempHome()
    const baseURL = await listingServer({ data: [{ id: 'qwen3', name: 'Qwen 3' }, { id: 'llama3.2' }] })
    const listed = await run(home, {
      kind: 'models-discover', provider: 'ollama-local', baseURL, add: false,
    })
    expect(listed.stdout).toContain('qwen3')
    expect(listed.stdout).toContain('llama3.2')
    const added = await run(home, {
      kind: 'models-discover', provider: 'ollama-local', baseURL, add: true,
    })
    expect(added.exit).toBe(0)
    const after = await run(home, { kind: 'models-list' })
    expect(after.stdout).toContain('qwen3')
    const empty = await run(home, {
      kind: 'models-discover', provider: 'ollama-local', baseURL: await listingServer({ data: [] }), add: true,
    })
    expect(empty.stdout).toContain('(no models advertised)')
    const unknown = await run(home, {
      kind: 'models-discover', provider: 'ghost', baseURL, add: true,
    })
    expect(unknown.exit).toBe(1)
    expect(unknown.stderr).toMatch(/cannot --add models for unknown provider/)
  })

  it('adds a shipped template and a custom route without taking a key from argv', async () => {
    const home = await tempHome()
    const template = await run(home, { kind: 'providers-add', template: 'ollama-local' })
    expect(template.stdout).toContain('Provider ollama-local saved.')
    const custom = await run(home, {
      kind: 'providers-add',
      template: 'custom',
      provider: 'acme-gateway',
      baseURL: 'http://127.0.0.1:9/v1',
      model: 'acme-large',
    }, [''])
    expect(custom.exit).toBe(0)
    expect(custom.stdout).toContain('Provider acme-gateway saved.')
    const listed = await run(home, { kind: 'models-list' })
    expect(listed.stdout).toContain('acme-gateway')
  })

  it('stores a prompted key in the credentials store', async () => {
    const home = await tempHome()
    const added = await run(home, { kind: 'providers-add', template: 'openai' }, ['sk-test-from-stdin'])
    expect(added.exit).toBe(0)
    const ctx = await bootModelsCli(home)
    const info = await ctx.credentials.describe(credentialRef('OPENAI_API_KEY'))
    expect(info.configured).toBe(true)
    await ctx.fiber.dispose()
  })

  it('removes a user-owned pi-ai route and refuses a non-pi-ai route', async () => {
    const home = await tempHome()
    await run(home, {
      kind: 'providers-add',
      template: 'custom',
      provider: 'acme-gateway',
      baseURL: 'http://127.0.0.1:9/v1',
      model: 'acme-large',
    }, [''])
    const removed = await run(home, { kind: 'providers-remove', provider: 'acme-gateway' })
    expect(removed.stdout).toContain('Provider acme-gateway removed.')
    const refuse = await run(home, { kind: 'providers-remove', provider: 'deepseek-official' })
    expect(refuse.exit).toBe(1)
    expect(refuse.stderr).toMatch(/not a user-owned pi-ai route/)
    const missing = await run(home, { kind: 'providers-remove', provider: 'ghost' })
    expect(missing.stderr).toMatch(/unknown provider "ghost"/)
  })

  it('prompts for an omitted template and rejects an unknown one', async () => {
    const home = await tempHome()
    const added = await run(home, { kind: 'providers-add' }, ['openai', ''])
    expect(added.exit).toBe(0)
    expect(added.stdout).toContain('Provider openai saved.')
    const bad = await run(home, { kind: 'providers-add' }, ['nope'])
    expect(bad.exit).toBe(1)
    expect(bad.stderr).toMatch(/unknown template "nope"/)
  })

  it('rejects an invalid custom provider id or a missing base URL / model', async () => {
    const home = await tempHome()
    const id = await run(home, { kind: 'providers-add', template: 'custom', provider: 'ACME' }, [])
    expect(id.stderr).toMatch(/Provider ID must start/)
    const url = await run(home, {
      kind: 'providers-add', template: 'custom', provider: 'acme-gateway',
    }, ['', 'm'])
    expect(url.stderr).toMatch(/needs a base URL/)
    const model = await run(home, {
      kind: 'providers-add', template: 'custom', provider: 'acme-gateway', baseURL: 'http://x/v1',
    }, [''])
    expect(model.stderr).toMatch(/needs a model id/)
  })
})
