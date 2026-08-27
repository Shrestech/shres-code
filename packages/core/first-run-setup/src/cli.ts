/**
 * Interactive first-run menu. Prompts go to the supplied stdout (headless
 * uses stderr so the task answer stays on stdout).
 *
 * @module @shres-code/shres-code-first-run-setup/cli
 */

import type { CliIo, FirstRunChoice, PickerOption } from './types.ts'
import { noProviderError } from './options.ts'

/** One numbered menu row plus its choice. */
interface MenuEntry {
  /** 1-based label printed to the user. */
  index: number
  /** Text after the number. */
  label: string
  /** Choice applied when this row is selected. */
  option: PickerOption
}

/**
 * Run the interactive picker and return the chosen configuration.
 * @param io - streams and TTY flag.
 * @param options - menu entries in print order.
 * @returns the choice to persist, or throws when the user quits or stdin ends.
 */
export async function runCliPicker(io: CliIo, options: readonly PickerOption[]): Promise<FirstRunChoice> {
  if (!io.isTTY) throw noProviderError()
  const menu = numberOptions(options)
  write(io.stdout, formatMenu(menu))
  for (;;) {
    write(io.stdout, '> ')
    const line = await readLine(io.stdin)
    if (line === 'q' || line === 'Q') throw noProviderError()
    const picked = menu.find(entry => String(entry.index) === line)
    if (picked === undefined) {
      write(io.stdout, 'Enter a listed number, or q to quit.\n')
      continue
    }
    return collectChoice(io, picked.option)
  }
}

/**
 * Format the numbered menu.
 * @param entries - numbered picker rows.
 * @returns the menu text, including the quit line.
 */
export function formatMenu(entries: readonly MenuEntry[]): string {
  const lines = [
    'No default model is configured, and no provider can serve requests yet.',
    '',
    'Choose a model provider:',
    ...entries.map(entry => `  ${String(entry.index)}. ${entry.label}`),
    '  q. Quit',
    '',
  ]
  return `${lines.join('\n')}\n`
}

/**
 * Assign 1-based indexes and printable labels.
 * @param options - first-run picker options in print order.
 * @returns menu rows ready for {@link formatMenu}.
 */
export function numberOptions(options: readonly PickerOption[]): MenuEntry[] {
  return options.map((option, offset) => ({
    index: offset + 1,
    label: labelOf(option),
    option,
  }))
}

function labelOf(option: PickerOption): string {
  switch (option.kind) {
    case 'ollama-local':
      return `${option.name} (Ollama local)`
    case 'template':
      return option.label
    case 'custom':
      return 'Custom base URL'
    /* v8 ignore next 4 -- closed-union exhaustiveness only */
    default: {
      const _never: never = option
      return String(_never)
    }
  }
}

async function collectChoice(io: CliIo, option: PickerOption): Promise<FirstRunChoice> {
  switch (option.kind) {
    case 'ollama-local':
      return { kind: 'ollama-local', model: option.model }
    case 'template': {
      if (option.apiKeyEnv === undefined) {
        return { kind: 'template', provider: option.provider, model: option.defaultModel }
      }
      write(io.stdout, `Enter API key for ${option.label} (${option.apiKeyEnv}):\n> `)
      const apiKey = await readSecret(io)
      if (apiKey.length === 0) {
        throw new Error(`first-run-setup: ${option.apiKeyEnv} is required for ${option.provider}`)
      }
      return { kind: 'template', provider: option.provider, apiKey, model: option.defaultModel }
    }
    case 'custom': {
      write(io.stdout, 'Provider ID (lowercase, e.g. acme-gateway):\n> ')
      const provider = await readLine(io.stdin)
      if (!/^[a-z][a-z0-9-]*$/.test(provider)) {
        throw new Error('first-run-setup: Provider ID must start with a lowercase letter and use lowercase letters, digits, and dashes')
      }
      write(io.stdout, 'Base URL (OpenAI-compatible, including /v1):\n> ')
      const baseURL = await readLine(io.stdin)
      if (baseURL.length === 0) throw new Error('first-run-setup: a custom provider needs a base URL')
      write(io.stdout, 'Model ID:\n> ')
      const model = await readLine(io.stdin)
      if (model.length === 0) throw new Error('first-run-setup: a custom provider needs a model id')
      write(io.stdout, 'API key (leave blank if the endpoint needs none):\n> ')
      const apiKey = await readSecret(io)
      return {
        kind: 'custom',
        provider,
        baseURL,
        model,
        api: 'openai-completions',
        ...apiKey.length === 0 ? {} : { apiKey },
      }
    }
    /* v8 ignore next 4 -- closed-union exhaustiveness only */
    default: {
      const _never: never = option
      throw new Error(`first-run-setup: unexpected option ${JSON.stringify(_never)}`)
    }
  }
}

function write(stream: NodeJS.WritableStream, text: string): void {
  stream.write(text)
}

interface LineSource {
  buffer: string
  ended: boolean
  /** When true, the attach listener ignores data so a hidden reader can own it. */
  paused?: boolean
  waiter?: { resolve: (line: string) => void; reject: (error: Error) => void }
}

const sources = new WeakMap<NodeJS.ReadableStream, LineSource>()

function takeLine(source: LineSource): string | undefined {
  const newline = source.buffer.indexOf('\n')
  if (newline < 0) return undefined
  const line = source.buffer.slice(0, newline).replace(/\r$/, '').trim()
  source.buffer = source.buffer.slice(newline + 1)
  return line
}

function attach(stdin: NodeJS.ReadableStream): LineSource {
  const existing = sources.get(stdin)
  if (existing !== undefined) return existing
  const source: LineSource = { buffer: '', ended: false }
  sources.set(stdin, source)
  stdin.on('data', (chunk: Buffer | string) => {
    if (source.paused === true) return
    source.buffer += String(chunk)
    const waiter = source.waiter
    if (waiter === undefined) return
    const line = takeLine(source)
    if (line === undefined) return
    delete source.waiter
    waiter.resolve(line)
  })
  stdin.on('end', () => {
    source.ended = true
    const waiter = source.waiter
    if (waiter === undefined) return
    delete source.waiter
    waiter.reject(new Error('first-run-setup: stdin closed before a provider was chosen'))
  })
  stdin.on('error', (error: Error) => {
    source.ended = true
    const waiter = source.waiter
    if (waiter === undefined) return
    delete source.waiter
    waiter.reject(error)
  })
  /* v8 ignore next 3 -- PassThrough and TTY ReadStream both expose resume */
  if (typeof (stdin as NodeJS.ReadStream).resume === 'function') {
    (stdin as NodeJS.ReadStream).resume()
  }
  return source
}

/**
 * Read one secret line. A real TTY disables echo; scripted stdin (PassThrough,
 * piped input) uses the ordinary line reader so tests stay deterministic.
 * @param io - streams and TTY flag.
 * @returns the trimmed secret.
 */
export async function readSecret(io: CliIo): Promise<string> {
  const stdin = io.stdin as NodeJS.ReadStream
  if (typeof stdin.setRawMode === 'function' &&  stdin.isTTY) {
    return readHiddenLine(stdin, io.stdout)
  }
  return readLine(io.stdin)
}

/**
 * Collect a line in raw mode so keystrokes do not echo. Pauses the shared
 * line attach so its data listener cannot steal the bytes.
 * @param stdin - a TTY ReadStream with `setRawMode`.
 * @param stdout - where to write the finishing newline.
 * @returns the typed secret.
 */
function readHiddenLine(stdin: NodeJS.ReadStream, stdout: NodeJS.WritableStream): Promise<string> {
  const source = sources.get(stdin)
  if (source !== undefined) source.paused = true
  const previous = stdin.isRaw
  stdin.setRawMode(true)
  return new Promise((resolve, reject) => {
    let buf = ''
    const onData = (chunk: Buffer | string): void => {
      for (const ch of String(chunk)) {
        if (ch === '\n' || ch === '\r') {
          cleanup()
          stdout.write('\n')
          resolve(buf)
          return
        }
        if (ch === '\u0003') {
          cleanup()
          reject(new Error('first-run-setup: interrupted'))
          return
        }
        if (ch === '\u007f' || ch === '\b') {
          buf = buf.slice(0, -1)
          continue
        }
        if (ch >= ' ' || ch === '\t') buf += ch
      }
    }
    const cleanup = (): void => {
      stdin.off('data', onData)
      stdin.setRawMode(previous)
      if (source !== undefined) source.paused = false
    }
    stdin.on('data', onData)
  })
}

/**
 * Read one line from a stream. Bytes after the first newline stay queued so a
 * scripted stdin that writes several lines at once still works. A closed
 * stdin with no queued line fails loud so a piped empty input cannot look
 * like a chosen provider.
 * @param stdin - line-oriented input.
 * @returns the trimmed line.
 */
export function readLine(stdin: NodeJS.ReadableStream): Promise<string> {
  const source = attach(stdin)
  const queued = takeLine(source)
  if (queued !== undefined) return Promise.resolve(queued)
  if (source.ended) {
    return Promise.reject(new Error('first-run-setup: stdin closed before a provider was chosen'))
  }
  return new Promise((resolve, reject) => {
    source.waiter = { resolve, reject }
  })
}
