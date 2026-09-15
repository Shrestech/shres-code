/**
 * Incremental stream-json event mapping for delegated CLI turns. Lines are
 * fed as the child writes them; recognized events (thinking deltas, assistant
 * messages, tool_call lifecycles, the result object) become stream chunks
 * immediately, and unrecognized shapes contribute nothing so the caller can
 * fall back to end-of-process parsing.
 * @module @shres-code/shres-code-llm-cli-bridge/stream
 */

import { toServerToolCallBlock } from '@shres-code/shres-code-llm'
import type { ContentBlock, StreamChunk, TokenUsage } from '@shres-code/shres-code-llm'
import { answerFromObject, isCliErrorPayload } from './answer.ts'
import { usageFromObject } from './parse.ts'

/** Snippet length cap for one delegated tool result summary. */
const TOOL_RESULT_SNIPPET_MAX_CHARS = 300

/** The tool_call payload's single key names the tool family (`shellToolCall`). */
function toolKindOf(toolCall: Record<string, unknown>): string {
  const key = Object.keys(toolCall)[0]
  if (key === undefined) return 'tool'
  const stripped = key.replace(/ToolCall$/, '')
  return stripped.length === 0 ? 'tool' : stripped.charAt(0).toLowerCase() + stripped.slice(1)
}

/** The family entry inside a tool_call payload (the `shellToolCall` object). */
function toolEntryOf(toolCall: Record<string, unknown>): Record<string, unknown> | undefined {
  const key = Object.keys(toolCall)[0]
  const entry = key === undefined ? undefined : toolCall[key]
  return typeof entry === 'object' && entry !== null ? entry as Record<string, unknown> : undefined
}

/** The args object inside a tool_call payload, when the family key holds one. */
function toolArgsOf(toolCall: Record<string, unknown>): Record<string, unknown> | undefined {
  const args = toolEntryOf(toolCall)?.args
  return typeof args === 'object' && args !== null ? args as Record<string, unknown> : undefined
}

/** A short human string naming what the delegated call did. */
function toolNameOf(args: Record<string, unknown> | undefined, kind: string): string | undefined {
  for (const field of ['description', 'command', 'path', 'query'] as const) {
    const value = args?.[field]
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return kind === 'tool' ? undefined : kind
}

/** A bounded result summary from a completed shell-family call, when present. */
function toolSnippetOf(toolCall: Record<string, unknown>): string | undefined {
  const result = toolEntryOf(toolCall)?.result
  if (typeof result !== 'object' || result === null) return undefined
  const success = (result as { success?: unknown }).success
  if (typeof success !== 'object' || success === null) return undefined
  const stdout = (success as { stdout?: unknown }).stdout
  if (typeof stdout !== 'string' || stdout.trim().length === 0) return undefined
  return stdout.length > TOOL_RESULT_SNIPPET_MAX_CHARS
    ? `${stdout.slice(0, TOOL_RESULT_SNIPPET_MAX_CHARS)}…`
    : stdout
}

/** Whether a completed tool_call payload reports failure. */
function toolFailed(toolCall: Record<string, unknown>): boolean {
  const result = toolEntryOf(toolCall)?.result
  if (typeof result !== 'object' || result === null) return false
  return 'failure' in result || 'error' in result
}

/** The error text an error payload carries in its common fields. */
function errorTextOf(event: Record<string, unknown>): string {
  for (const key of ['result', 'message', 'error'] as const) {
    const value = event[key]
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return JSON.stringify(event)
}

/** CLI call ids can embed newlines (cursor-agent); keep the first line. */
function normalizeCallId(callId: unknown): string | undefined {
  if (typeof callId !== 'string') return undefined
  const firstLine = callId.split('\n')[0]?.trim()
  return firstLine === undefined || firstLine.length === 0 ? undefined : firstLine
}

interface OpenBlock {
  kind: 'text' | 'reasoning' | 'server-tool-call'
  index: number
  text: string
}

interface StartedToolCall {
  index: number
  kind: string
  name?: string
}

/**
 * Stateful stream-json event→chunk mapper. Feed stdout increments with
 * {@link feed}, drain at process end with {@link flush}. Blocks open and close
 * in event order: a thinking run becomes one reasoning block, each distinct
 * assistant message one text block (a same-call snapshot that only grew
 * extends its open block), and each tool_call lifecycle one server-tool-call
 * block the agent loop never dispatches.
 */
export class CliStreamMapper {
  private pending = ''
  private open: OpenBlock | undefined
  private nextIndex = 0
  private lastAssistant: { text: string; callId?: string } | undefined
  private readonly toolCalls = new Map<string, StartedToolCall>()
  private resultText: string | undefined
  private resultUsage: TokenUsage | undefined
  private sawResult = false
  private emittedText = false

  /**
   * Whether any assistant text or result object has been seen. When false
   * after flush, the transcript holds no recognized events and the caller
   * should fall back to whole-transcript parsing.
   */
  get hadContent(): boolean {
    return this.emittedText || this.sawResult
  }

  /**
   * Feed one stdout increment; complete lines parse as NDJSON events and
   * unrecognized lines or events are ignored (commentary, foreign shapes).
   * @param text - newly written stdout bytes as text.
   * @returns chunks produced by the events completed in this increment.
   */
  feed(text: string): StreamChunk[] {
    this.pending += text
    const lines = this.pending.split('\n')
    /* v8 ignore next -- split always returns at least one element, so pop() is never undefined */
    this.pending = lines.pop() ?? ''
    const chunks: StreamChunk[] = []
    for (const line of lines) {
      const event = parseLine(line)
      if (event !== undefined) chunks.push(...this.mapEvent(event))
    }
    return chunks
  }

  /**
   * Drain the mapper at process end: parse any unterminated tail line, close
   * the open block, emit the result text when no assistant event carried one,
   * and report usage last.
   * @returns the closing chunks; the caller appends the finish chunk.
   */
  flush(): StreamChunk[] {
    const chunks: StreamChunk[] = []
    if (this.pending.trim().length > 0) {
      const event = parseLine(this.pending)
      this.pending = ''
      if (event !== undefined) chunks.push(...this.mapEvent(event))
    }
    if (!this.emittedText && this.resultText !== undefined && this.resultText.trim().length > 0) {
      this.emittedText = true
      const { chunks: opened, block } = this.replaceOpen('text')
      chunks.push(...opened)
      block.text += this.resultText
      chunks.push({ type: 'text-delta', index: block.index, text: this.resultText })
    }
    chunks.push(...this.closeBlock())
    if (this.resultUsage !== undefined) chunks.push({ type: 'usage', usage: this.resultUsage })
    return chunks
  }

  /** Close whatever is open and open a new block, returning both products. */
  private replaceOpen(kind: OpenBlock['kind']): { chunks: StreamChunk[]; block: OpenBlock } {
    const chunks = this.closeBlock()
    const block: OpenBlock = { kind, index: this.nextIndex, text: '' }
    this.nextIndex += 1
    this.open = block
    chunks.push({ type: 'block-start', index: block.index, blockType: kind })
    return { chunks, block }
  }

  private closeBlock(): StreamChunk[] {
    const block = this.open
    if (block === undefined) return []
    this.open = undefined
    if (block.kind === 'server-tool-call') return []
    const content: ContentBlock = block.kind === 'text'
      ? { type: 'text', text: block.text }
      : { type: 'reasoning', text: block.text }
    return [{ type: 'block-end', index: block.index, block: content }]
  }

  private mapEvent(event: Record<string, unknown>): StreamChunk[] {
    if (isCliErrorPayload(event) && event.type !== 'tool_call') {
      throw new Error(`llm-cli-bridge: CLI reported an error: ${errorTextOf(event)}`)
    }
    if (event.type === 'thinking') {
      const text = event.text
      if (event.subtype === 'delta' && typeof text === 'string' && text.length > 0) {
        const current = this.open
        const { chunks, block } = current !== undefined && current.kind === 'reasoning'
          ? { chunks: [] as StreamChunk[], block: current }
          : this.replaceOpen('reasoning')
        block.text += text
        chunks.push({ type: 'reasoning-delta', index: block.index, text })
        return chunks
      }
      if (event.subtype === 'completed') return this.closeBlock()
      return []
    }
    if (event.type === 'tool_call') {
      const toolCall = event.tool_call
      if (typeof toolCall !== 'object' || toolCall === null) return []
      const payload = toolCall as Record<string, unknown>
      const callId = normalizeCallId(event.call_id)
      if (event.subtype === 'started') {
        const args = toolArgsOf(payload)
        const kind = toolKindOf(payload)
        const started: StartedToolCall = { index: this.nextIndex, kind }
        const name = toolNameOf(args, kind)
        if (name !== undefined) started.name = name
        if (callId !== undefined) this.toolCalls.set(callId, started)
        const chunks = this.closeBlock()
        chunks.push({ type: 'block-start', index: started.index, blockType: 'server-tool-call' })
        this.open = { kind: 'server-tool-call', index: started.index, text: '' }
        this.nextIndex += 1
        return chunks
      }
      if (event.subtype === 'completed') {
        const started = callId === undefined ? undefined : this.toolCalls.get(callId)
        const args = toolArgsOf(payload)
        const kind = started?.kind ?? toolKindOf(payload)
        const name = started?.name ?? toolNameOf(args, kind)
        const snippet = toolSnippetOf(payload)
        const block = toServerToolCallBlock({
          kind,
          ...name === undefined ? {} : { name },
          ...callId === undefined ? {} : { id: callId },
          status: toolFailed(payload) ? 'failed' : 'completed',
          // The title is always non-empty (kind is the floor), so one summary
          // entry exists per completed call; the snippet joins when the
          // family reports output.
          results: [{ title: name ?? kind, ...snippet === undefined ? {} : { snippet } }],
        })
        const chunks: StreamChunk[] = []
        const open = this.open
        let index: number
        if (open !== undefined
          && open.kind === 'server-tool-call'
          && started !== undefined
          && open.index === started.index
        ) {
          index = open.index
        } else {
          chunks.push(...this.closeBlock())
          index = this.nextIndex
          chunks.push({ type: 'block-start', index, blockType: 'server-tool-call' })
          this.nextIndex += 1
        }
        this.open = undefined
        chunks.push({ type: 'block-end', index, block })
        return chunks
      }
      return []
    }
    if (event.type === 'result' || (event.type === undefined && typeof event.result === 'string')) {
      this.sawResult = true
      const text = event.result
      if (typeof text === 'string') this.resultText = text
      this.resultUsage = usageFromObject(event)
      return []
    }
    const role = event.role
    if (typeof role === 'string' && role !== 'assistant') return []
    const text = event.type === 'assistant' || role === 'assistant'
      ? answerFromObject(event.message) ?? answerFromObject(event)
      : undefined
    if (text === undefined) return []
    return this.pushAssistantText(text, assistantCallIdOf(event))
  }

  private pushAssistantText(text: string, callId: string | undefined): StreamChunk[] {
    const last = this.lastAssistant
    // A snapshot update re-sends the same call's grown text; a fresh message —
    // including one whose event simply omits model_call_id — opens a new block.
    const continuation = callId !== undefined
      && last !== undefined
      && last.callId === callId
      && text.startsWith(last.text)
    if (this.open?.kind === 'text' && continuation) {
      const delta = text.slice(last.text.length)
      this.lastAssistant = { text, callId }
      if (delta.length === 0) return []
      this.open.text += delta
      return [{ type: 'text-delta', index: this.open.index, text: delta }]
    }
    const { chunks, block } = this.replaceOpen('text')
    this.lastAssistant = { text, ...(callId === undefined ? {} : { callId }) }
    this.emittedText = true
    block.text += text
    chunks.push({ type: 'text-delta', index: block.index, text })
    return chunks
  }
}

/** The snapshot-continuation id an assistant event carries, when it does. */
function assistantCallIdOf(event: Record<string, unknown>): string | undefined {
  if (typeof event.model_call_id === 'string') return event.model_call_id
  const message = event.message
  if (typeof message === 'object' && message !== null) {
    const id = (message as { id?: unknown }).id
    if (typeof id === 'string') return id
  }
  return undefined
}

/** Parse one transcript line, tolerating blank and non-JSON commentary. */
function parseLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim()
  if (trimmed.length === 0) return undefined
  try {
    const value: unknown = JSON.parse(trimmed)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}
