// Keyless assembled-browser coverage for the Models page Audio card and the
// cloud speech path it configures: the card fetches audio models from a stub
// OpenAI-compatible endpoint, the Apply write lands in settings.yaml, the
// user-layer pin re-points the live speech seat at the cloud providers, and
// real transcribe/synthesize rounds run over HTTP against the stub — through
// the composed SpeechRuntime, the credential seam, and the real settings
// section. Zero model calls and zero real network: the stub is a local
// node:http server speaking the OpenRouter wire shapes.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const STUB_KEY = 'sk-stub-e2e'

/** One PCM16 WAV: 44-byte canonical header plus `samples` signed 16-bit frames. */
function stubWav(samples: readonly number[]): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(out.buffer)
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 16_000, true)
  view.setUint32(28, 32_000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  samples.forEach((sample, index) => { view.setInt16(44 + index * 2, sample, true) })
  return out
}

/** What the stub endpoint saw in one request. */
interface StubCall {
  path: string
  authorization: string | undefined
  body: string
}

/**
 * A local OpenAI-compatible endpoint: `/models` lists two audio models and
 * one plain-chat model, `/chat/completions` answers an `input_audio` request
 * with a transcript and a `modalities` request with an SSE audio stream.
 * Every request must carry the stub bearer key, so the rounds below prove the
 * stored credential reached the provider.
 */
async function launchStubEndpoint(): Promise<{ server: Server; url: string; calls: StubCall[] }> {
  const calls: StubCall[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse): void => {
    const chunks: Buffer[] = []
    void (async () => {
      for await (const chunk of request) chunks.push(chunk as Buffer)
      const body = Buffer.concat(chunks).toString('utf8')
      const call: StubCall = {
        path: request.url ?? '',
        authorization: request.headers.authorization,
        body,
      }
      calls.push(call)
      if (request.headers.authorization !== `Bearer ${STUB_KEY}`) {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'bad key' } }))
        return
      }
      if (request.url?.endsWith('/models') === true) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          data: [
            { id: 'stub-stt', architecture: { input_modalities: ['audio'], output_modalities: ['text'] } },
            { id: 'stub-tts', architecture: { input_modalities: ['text'], output_modalities: ['text', 'audio'] } },
            { id: 'plain-chat', architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
          ],
        }))
        return
      }
      if (body.includes('"modalities"')) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        const delta = Buffer.from([9, 8, 7]).toString('base64')
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { audio: { data: delta } } }] })}\n\n`)
        response.write('data: [DONE]\n\n')
        response.end()
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: '  stub transcript ' } }] }))
    })().catch(() => {
      response.destroy()
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port
  return { server, url: `http://127.0.0.1:${port}/v1`, calls }
}

describe('web e2e: Models Audio card configures the cloud speech seat', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let stub: { server: Server; url: string; calls: StubCall[] }

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    stub = await launchStubEndpoint()
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 60_000 })
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    stub?.server.close()
    await scaffold?.close()
  })

  it('offers the cloud engine, fetches its audio models, and applies the pins', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-speech-audio'))
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: 'Model' }).click()
    const card = dialog.getByText('Audio: speech-to-text and read-aloud', { exact: true })
    await card.waitFor({ timeout: 10_000 })

    // The engine selects always offer the composition default and the cloud
    // ids; the local option appears only when a local engine resolves ready,
    // which this scaffold cannot promise (weights are never downloaded).
    const sttEngine = dialog.getByLabel('Speech-to-text engine')
    await sttEngine.waitFor({ timeout: 10_000 })
    expect(await sttEngine.getByRole('option', { name: 'Composition default' }).count()).toBe(1)
    expect(await sttEngine.getByRole('option', { name: 'Cloud (OpenAI-compatible)' }).count()).toBe(1)
    expect(await dialog.getByLabel('Read-aloud engine').getByRole('option', { name: 'Cloud (OpenAI-compatible)' }).count()).toBe(1)

    // Point the cloud profile at the stub endpoint and ask it what it serves.
    await dialog.getByLabel('Base URL', { exact: true }).fill(stub.url)
    await dialog.getByLabel('API key', { exact: true }).fill(STUB_KEY)
    await dialog.getByRole('button', { name: 'Fetch audio models' }).click()
    // The picker is its own top-level dialog, like every nested modal here.
    const picker = page.getByRole('dialog', { name: 'Audio models on this endpoint' })
    await picker.waitFor({ timeout: 15_000 })
    expect(await picker.getByText('stub-stt', { exact: true }).count()).toBe(1)
    expect(await picker.getByText('stub-tts', { exact: true }).count()).toBe(1)
    // The plain-chat model is filtered out of the audio picker.
    expect(await picker.getByText('plain-chat', { exact: true }).count()).toBe(0)

    // Each flagged row assigns to its direction only.
    await picker.getByRole('button', { name: 'STT' }).first().click()
    await expect.poll(async () => dialog.getByLabel('STT model ID').inputValue(), { timeout: 5_000 }).toBe('stub-stt')
    await dialog.getByRole('button', { name: 'Fetch audio models' }).click()
    await picker.getByRole('button', { name: 'TTS' }).nth(1).click()
    await expect.poll(async () => dialog.getByLabel('TTS model ID').inputValue(), { timeout: 5_000 }).toBe('stub-tts')

    // Pin both engines on the cloud providers and apply.
    await dialog.getByLabel('Speech-to-text engine').selectOption({ label: 'Cloud (OpenAI-compatible)' })
    await dialog.getByLabel('Read-aloud engine').selectOption({ label: 'Cloud (OpenAI-compatible)' })
    await dialog.getByRole('button', { name: 'Apply audio settings' }).click()
    await dialog.getByText('Audio settings saved.', { exact: true }).waitFor({ timeout: 10_000 })
    await expect.poll(async () => readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8'), { timeout: 10_000 })
      .toMatch(/speech:[\s\S]*sttProvider:\s*openai-compatible-stt[\s\S]*ttsProvider:\s*openai-compatible-tts/s)
    const document = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(document).toContain(`baseURL: ${stub.url}`)
    expect(document).toContain('sttModel: stub-stt')
    expect(document).toContain('ttsModel: stub-tts')

    // The key stores under the composed default reference, write-only.
    await expect.poll(async () => readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8'), { timeout: 5_000 })
      .not.toMatch(new RegExp(STUB_KEY))
  }, 90_000)

  it('re-points the live speech seat and runs real cloud rounds against the stub', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-speech-audio-rounds'))
    // The user-layer pin wins: status resolves the cloud providers now.
    const status = await scaffold.ctx.speech.status()
    expect(status.stt).toEqual({ kind: 'ready', providerId: 'openai-compatible-stt' })
    expect(status.tts).toEqual({ kind: 'ready', providerId: 'openai-compatible-tts' })

    // STT round: WAV bytes ride the wire as canonical base64; the transcript
    // comes back from the stub through the composed runtime.
    const wav = stubWav([100, -200, 300, -400])
    const round = await scaffold.ctx.speech.transcribeRemote({
      audioBase64: Buffer.from(wav).toString('base64'),
      mediaType: 'audio/wav',
    })
    expect(round.ok).toBe(true)
    if (!round.ok) throw new Error('expected the cloud STT round to succeed')
    expect(round.value).toEqual({ text: 'stub transcript' })
    const sttCall = stub.calls.find(call => call.body.includes('"input_audio"'))
    expect(sttCall).toBeDefined()
    expect(sttCall?.authorization).toBe(`Bearer ${STUB_KEY}`)
    expect(sttCall?.body).toContain(`"data":"${Buffer.from(wav).toString('base64')}"`)
    expect(sttCall?.body).toContain('"format":"wav"')

    // TTS round: the SSE audio deltas reassemble into the returned bytes, and
    // the local default voice never reaches the endpoint.
    const spoken = await scaffold.ctx.speech.synthesizeRemote({ text: 'Hello there' })
    expect(spoken.ok).toBe(true)
    if (!spoken.ok || spoken.value.kind !== 'audio') throw new Error('expected the cloud TTS round to return audio')
    expect(spoken.value.voiceId).toBe('alloy')
    expect(spoken.value.mediaType).toBe('audio/wav')
    expect(Buffer.from(spoken.value.audioBase64, 'base64')).toEqual(Buffer.from([9, 8, 7]))
    const ttsCall = stub.calls.find(call => call.body.includes('"modalities"'))
    expect(ttsCall).toBeDefined()
    const ttsBody = JSON.parse(typeof ttsCall?.body === 'string' ? ttsCall.body : '{}') as { audio?: unknown }
    expect(ttsBody.audio).toEqual({ voice: 'alloy', format: 'wav' })
  }, 60_000)

  it('leaves the page without console errors', async () => {
    expect(tripwire.pageErrors).toEqual([])
  })
})
