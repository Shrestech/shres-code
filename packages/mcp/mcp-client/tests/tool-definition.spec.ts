/**
 * Image admission for one MCP tool definition: durable attachments when the
 * route accepts images, and diagnostic text for every other image result.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@shres-code/cordis'
import { AttachmentError, AttachmentId } from '@shres-code/shres-code-attachment'
import SystemPrompt from '@shres-code/shres-code-system-prompt'
import type { ImageAttachmentRef } from '@shres-code/shres-code-attachment'
import { CallId } from '@shres-code/shres-code-llm'
import ToolRuntime, { type JsonValue, type ToolExecutionToken, type ToolRunContext } from '@shres-code/shres-code-tools'
import { createMcpToolDefinition } from '@shres-code/shres-code-mcp-client/src/tools.ts'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const imageRef: ImageAttachmentRef = {
  attachmentId: AttachmentId('att-1'),
  mediaType: 'image/png',
  bytes: 1,
  width: 1,
  height: 1,
}

class FakeLlm extends Service {
  readonly resolveModelInfo: ReturnType<typeof vi.fn>

  constructor(ctx: Context, resolveModelInfo: ReturnType<typeof vi.fn>) {
    super(ctx, 'llm')
    this.resolveModelInfo = resolveModelInfo
  }
}

class FakeAttachments extends Service {
  readonly saveImages: ReturnType<typeof vi.fn>

  constructor(ctx: Context, saveImages: ReturnType<typeof vi.fn>) {
    super(ctx, 'attachments')
    this.saveImages = saveImages
  }
}

async function mountRegistry(mode?: 'code'): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, mode === undefined ? {} : { mode })
  return ctx
}

function agent(options: { provider?: string; model?: string }, header?: { provider: string; model: string }): ToolRunContext['agent'] {
  return {
    options,
    session: { requestHeader: () => header === undefined ? undefined : { config: header } },
  } as unknown as ToolRunContext['agent']
}

function execution(options?: { agent?: ToolRunContext['agent']; signal?: AbortSignal }): ToolRunContext {
  return { signal: options?.signal ?? new AbortController().signal, agent: options?.agent } as unknown as ToolRunContext
}

async function executeImage(
  ctx: Context,
  content: JsonValue[],
  exec: ToolRunContext,
): Promise<Awaited<ReturnType<Context['tools']['execute']>>> {
  const definition = createMcpToolDefinition(ctx, {
    name: 'mcp__srv__img',
    rawName: 'img',
    description: '',
    inputSchema: { type: 'object' },
    call: async () => ({ content }),
  })
  ctx.tools.register(definition)
  return ctx.tools.execute({
    signal: exec.signal,
    callId: CallId('img'),
    name: definition.name,
    arguments: {},
    ...(exec.agent === undefined ? {} : { agent: exec.agent }),
  })
}

function textOf(result: Awaited<ReturnType<Context['tools']['execute']>>): string {
  return result.content.map(block => block.type === 'text' ? block.text : JSON.stringify(block)).join('\n')
}

describe('createMcpToolDefinition image projection', () => {
  it('returns undefined from finalizeContent until an image result is staged', async () => {
    const ctx = await mountRegistry()
    const exec = execution()
    const definition = createMcpToolDefinition(ctx, {
      name: 'mcp__srv__text',
      rawName: 'text',
      description: '',
      inputSchema: { type: 'object' },
      call: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    })
    expect(definition.finalizeContent?.(exec, { isError: false, value: { content: [] }, content: [] })).toBeUndefined()
    const value = await definition.execute({}, exec) as JsonValue
    const content = definition.output.render({}, value)
    expect(definition.finalizeContent?.(exec, { isError: false, value, content })).toBeUndefined()
  })

  it('replaces finalized content only when the value and fallback still match', async () => {
    const ctx = await mountRegistry()
    const exec = execution()
    const definition = createMcpToolDefinition(ctx, {
      name: 'mcp__srv__img',
      rawName: 'img',
      description: '',
      inputSchema: { type: 'object' },
      call: async () => ({ content: [{ type: 'image', mimeType: 'image/png', data: 'base64-data' }] }),
    })
    const value = await definition.execute({}, exec) as JsonValue
    const content = definition.output.render({}, value)
    expect(definition.finalizeContent?.(exec, {
      isError: true,
      error: { message: 'failed' },
      content,
    })).toBeUndefined()

    await definition.execute({}, exec)
    expect(definition.finalizeContent?.(exec, { isError: false, value: { content: [] }, content })).toBeUndefined()

    await definition.execute({}, exec)
    expect(definition.finalizeContent?.(exec, { isError: false, value, content: [] })).toBeUndefined()

    await definition.execute({}, exec)
    const projected = definition.finalizeContent?.(exec, { isError: false, value, content })
    expect(projected).toEqual([{
      type: 'text',
      text: '[image unavailable: image/png; the image data is not canonical base64; raw image data remains available to programmatic callers]',
    }])
    expect(definition.finalizeContent?.(exec, { isError: false, value, content })).toBeUndefined()
  })

  it('describes missing, non-canonical, and undeclared image bytes', async () => {
    const ctx = await mountRegistry()
    const missing = await executeImage(ctx, [{ type: 'image', mimeType: 'image/png' }], execution())
    expect(textOf(missing)).toContain('the image data is not canonical base64')

    const roundTrip = await executeImage(
      await mountRegistry(),
      [{ type: 'image', mimeType: 'image/png', data: 'AB==' }],
      execution(),
    )
    expect(textOf(roundTrip)).toContain('the image data is not canonical base64')

    const wrongType = await executeImage(
      await mountRegistry(),
      [{ type: 'image', mimeType: 'image/tiff', data: PNG }],
      execution(),
    )
    expect(textOf(wrongType)).toContain('image/tiff; the declared media type is not PNG, JPEG, WebP, or GIF')
  })

  it('refuses every image in a batch when one image is invalid', async () => {
    const ctx = await mountRegistry()
    const result = await executeImage(ctx, [
      { type: 'text', text: 'before' },
      { type: 'image', mimeType: 'image/png', data: PNG },
      { type: 'image', mimeType: 'image/png', data: 'AB==' },
    ], execution())
    expect(result.content).toEqual([
      { type: 'text', text: 'before' },
      {
        type: 'text',
        text: '[image unavailable: image/png; another image in the same result was invalid; raw image data remains available to programmatic callers]',
      },
      {
        type: 'text',
        text: '[image unavailable: image/png; the image data is not canonical base64; raw image data remains available to programmatic callers]',
      },
    ])
  })

  it('names the admission failure when no store, route, or image capability is available', async () => {
    const noStore = await executeImage(await mountRegistry(), [{ type: 'image', mimeType: 'image/png', data: PNG }], execution())
    expect(textOf(noStore)).toContain('no attachment store is mounted')

    const noAgent = await mountRegistry()
    new FakeAttachments(noAgent, vi.fn())
    new FakeLlm(noAgent, vi.fn(async () => ({ inputModalities: ['image'] })))
    expect(textOf(await executeImage(noAgent, [{ type: 'image', mimeType: 'image/png', data: PNG }], execution())))
      .toContain('the current model route could not be resolved')

    const modelMissing = await mountRegistry()
    new FakeAttachments(modelMissing, vi.fn())
    new FakeLlm(modelMissing, vi.fn(async () => ({ inputModalities: ['image'] })))
    expect(textOf(await executeImage(
      modelMissing,
      [{ type: 'image', mimeType: 'image/png', data: PNG }],
      execution({ agent: agent({ provider: 'opt' }) }),
    ))).toContain('the current model route could not be resolved')

    const noLlm = await mountRegistry()
    new FakeAttachments(noLlm, vi.fn())
    expect(textOf(await executeImage(
      noLlm,
      [{ type: 'image', mimeType: 'image/png', data: PNG }],
      execution({ agent: agent({ provider: 'opt', model: 'opt-model' }) }),
    ))).toContain('the current model route could not be resolved')

    const unverified = await mountRegistry()
    new FakeAttachments(unverified, vi.fn())
    new FakeLlm(unverified, vi.fn(async () => { throw new Error('catalog down') }))
    expect(textOf(await executeImage(
      unverified,
      [{ type: 'image', mimeType: 'image/png', data: PNG }],
      execution({ agent: agent({ provider: 'opt', model: 'opt-model' }) }),
    ))).toContain('the current model route could not be verified')

    const noModality = await mountRegistry()
    new FakeAttachments(noModality, vi.fn())
    new FakeLlm(noModality, vi.fn(async () => ({})))
    expect(textOf(await executeImage(
      noModality,
      [{ type: 'image', mimeType: 'image/png', data: PNG }],
      execution({ agent: agent({ provider: 'opt', model: 'opt-model' }) }),
    ))).toContain('model "opt-model" does not declare image input')

    const textOnly = await mountRegistry()
    new FakeAttachments(textOnly, vi.fn())
    new FakeLlm(textOnly, vi.fn(async () => ({ inputModalities: ['text'] })))
    expect(textOf(await executeImage(
      textOnly,
      [{ type: 'image', mimeType: 'image/png', data: PNG }],
      execution({ agent: agent({}, { provider: 'header', model: 'header-model' }) }),
    ))).toContain('model "header-model" does not declare image input')
  })

  it('uses the agent options when the request header has no route', async () => {
    const ctx = await mountRegistry()
    const resolveModelInfo = vi.fn(async () => ({ inputModalities: ['text'] }))
    new FakeAttachments(ctx, vi.fn())
    new FakeLlm(ctx, resolveModelInfo)
    await executeImage(
      ctx,
      [{ type: 'image', mimeType: 'image/png', data: PNG }],
      execution({ agent: agent({ provider: 'opt', model: 'opt-model' }) }),
    )
    expect(resolveModelInfo).toHaveBeenCalledWith('opt', 'opt-model', expect.any(AbortSignal))
  })

  it('stops before storage when the call is canceled after the route check', async () => {
    const ctx = await mountRegistry()
    const controller = new AbortController()
    const saveImages = vi.fn()
    new FakeAttachments(ctx, saveImages)
    new FakeLlm(ctx, vi.fn(async () => {
      controller.abort()
      return { inputModalities: ['image'] }
    }))
    const definition = createMcpToolDefinition(ctx, {
      name: 'mcp__srv__img',
      rawName: 'img',
      description: '',
      inputSchema: { type: 'object' },
      call: async () => ({ content: [{ type: 'image', mimeType: 'image/png', data: PNG }] }),
    })
    const exec = execution({
      agent: agent({ provider: 'opt', model: 'opt-model' }),
      signal: controller.signal,
    })
    // The registry replaces an aborted call with its own cancellation result.
    // The definition records the refusal on the projection instead.
    const value = await definition.execute({}, exec) as JsonValue
    const content = definition.output.render({}, value)
    const projected = definition.finalizeContent?.(exec, { isError: false, value, content })
    const block = projected?.[0]
    expect(block?.type).toBe('text')
    if (block?.type !== 'text') throw new Error('expected a text refusal')
    expect(block.text).toContain('the tool call was canceled before image storage')
    expect(saveImages).not.toHaveBeenCalled()
  })

  it('keeps a diagnostic when durable storage rejects the batch', async () => {
    const admitted = await mountRegistry()
    new FakeLlm(admitted, vi.fn(async () => ({ inputModalities: ['image'] })))
    new FakeAttachments(admitted, vi.fn(async () => {
      throw new AttachmentError('too big', 'IMAGE_TOO_LARGE')
    }))
    const admittedResult = await executeImage(
      admitted,
      [{ type: 'image', mimeType: 'image/png', data: PNG }],
      execution({ agent: agent({ provider: 'opt', model: 'm' }) }),
    )
    expect(textOf(admittedResult)).toContain('image admission rejected the result: too big')

    const stored = await mountRegistry()
    new FakeLlm(stored, vi.fn(async () => ({ inputModalities: ['image'] })))
    new FakeAttachments(stored, vi.fn(async () => { throw new Error('disk full') }))
    const storedResult = await executeImage(
      stored,
      [{ type: 'image', mimeType: 'image/png', data: PNG }],
      execution({ agent: agent({ provider: 'opt', model: 'm' }) }),
    )
    expect(textOf(storedResult)).toContain('durable image storage rejected the result')
  })

  it('stores an admitted image and leaves the canonical bytes on the tool value', async () => {
    const ctx = await mountRegistry()
    const saveImages = vi.fn(async () => [imageRef])
    new FakeLlm(ctx, vi.fn(async () => ({ inputModalities: ['image', 'text'] })))
    new FakeAttachments(ctx, saveImages)
    const exec = execution({ agent: agent({ provider: 'opt', model: 'opt-model' }, { provider: 'header', model: 'header-model' }) })
    const result = await executeImage(ctx, [
      { type: 'text', text: 'before' },
      { type: 'image', mimeType: 'image/png', data: PNG },
      { type: 'text', text: 'after' },
    ], exec)
    expect(saveImages).toHaveBeenCalledOnce()
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([
      { type: 'text', text: 'before' },
      { type: 'image', attachment: imageRef },
      { type: 'text', text: 'after' },
    ])
    if (result.isError) throw new Error('expected admitted image success')
    expect(result.value).toEqual({
      content: [
        { type: 'text', text: 'before' },
        { type: 'image', mimeType: 'image/png', data: PNG },
        { type: 'text', text: 'after' },
      ],
    })
    expect(result.additionalContexts).toBeUndefined()
  })

  it('forwards an admitted image from a nested Code Mode call and keeps the raw MCP value', async () => {
    const ctx = await mountRegistry('code')
    const saveImages = vi.fn(async () => [imageRef])
    new FakeLlm(ctx, vi.fn(async () => ({ inputModalities: ['image', 'text'] })))
    new FakeAttachments(ctx, saveImages)
    const content = [
      { type: 'text', text: 'before' },
      { type: 'image', mimeType: 'image/png', data: PNG },
      { type: 'text', text: 'after' },
    ]
    const definition = createMcpToolDefinition(ctx, {
      name: 'mcp__srv__img',
      rawName: 'img',
      description: '',
      inputSchema: { type: 'object' },
      call: async () => ({ content }),
    })
    ctx.tools.register(definition)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('img'),
      name: definition.name,
      arguments: {},
      agent: agent({ provider: 'opt', model: 'opt-model' }),
      parent: Symbol('run_code') as ToolExecutionToken,
    })
    expect(saveImages).toHaveBeenCalledOnce()
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected admitted image success')
    expect(result.value).toEqual({ content })
    expect(result.additionalContexts).toHaveLength(1)
    expect(result.additionalContexts?.[0]?.source).toEqual({ kind: 'plugin', plugin: 'mcp-client' })
    expect(result.additionalContexts?.[0]?.content).toEqual([
      { type: 'text', text: 'before' },
      { type: 'image', attachment: imageRef },
      { type: 'text', text: 'after' },
    ])
  })

  it('does not forward a refused image from a nested Code Mode call', async () => {
    const ctx = await mountRegistry('code')
    new FakeLlm(ctx, vi.fn(async () => ({ inputModalities: ['text'] })))
    new FakeAttachments(ctx, vi.fn())
    const definition = createMcpToolDefinition(ctx, {
      name: 'mcp__srv__img',
      rawName: 'img',
      description: '',
      inputSchema: { type: 'object' },
      call: async () => ({ content: [{ type: 'image', mimeType: 'image/png', data: PNG }] }),
    })
    ctx.tools.register(definition)
    const nested = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('img'),
      name: definition.name,
      arguments: {},
      agent: agent({ provider: 'opt', model: 'opt-model' }),
      parent: Symbol('run_code') as ToolExecutionToken,
    })
    expect(textOf(nested)).toContain('does not declare image input')
    expect(nested.additionalContexts).toBeUndefined()
    if (nested.isError) throw new Error('expected the raw value to remain available')
    expect(nested.value).toEqual({
      content: [{ type: 'image', mimeType: 'image/png', data: PNG }],
    })
  })
})
