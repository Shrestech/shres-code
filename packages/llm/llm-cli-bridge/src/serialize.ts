/**
 * Flatten harness messages into one CLI prompt string.
 * @module @shres-code/shres-code-llm-cli-bridge/serialize
 */

import type { ContentBlock, GenerateOptions, Message } from '@shres-code/shres-code-llm'

/**
 * Render one content-block list as plain text.
 * @param blocks - message content.
 * @returns concatenated text, with non-text blocks named in brackets.
 */
export function renderBlocks(blocks: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        parts.push(block.text)
        break
      case 'reasoning':
        parts.push(block.text)
        break
      case 'image':
        parts.push('[image]')
        break
      case 'tool-call':
        parts.push(`[tool-call ${block.name} ${block.arguments}]`)
        break
      case 'tool-result':
        parts.push(renderBlocks(block.content))
        break
      default:
        break
    }
  }
  return parts.join('')
}

/**
 * Serialize `system` plus `messages` into one prompt for a headless CLI.
 * @param options - the assembled request.
 * @returns the prompt text.
 */
export function serializePrompt(options: Pick<GenerateOptions, 'system' | 'messages'>): string {
  const sections: string[] = []
  if (options.system !== undefined && options.system.length > 0) {
    sections.push(options.system)
  }
  for (const message of options.messages) {
    sections.push(`${labelOf(message)}\n${renderBlocks(message.content)}`)
  }
  return sections.join('\n\n')
}

function labelOf(message: Message): string {
  switch (message.role) {
    case 'user':
      return message.source.kind === 'tool' ? 'tool' : 'user'
    case 'assistant':
      return 'assistant'
    default:
      return 'user'
  }
}
