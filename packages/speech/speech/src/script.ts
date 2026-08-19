/**
 * Convert assistant markdown into a speakable script.
 * @module @shres-code/shres-code-speech/script
 */

/** Trailing clause appended when the script is cut at `maxChars`. */
export const SPEECH_TRUNCATION_CLAUSE = ' The rest was omitted.'

const FENCED_CODE = /```[\s\S]*?```/g
const TILDE_FENCE = /~~~[\s\S]*?~~~/g
const TABLE_BLOCK = /(?:^|\n)(?:\|.*\|(?:\n|$))+/g
const IMAGE = /!\[([^\]]*)\]\([^)]*\)/g
const LINK = /\[([^\]]+)\]\([^)]*\)/g
const AUTOLINK = /<https?:\/\/[^>]+>/g
const INLINE_CODE = /`([^`]+)`/g
const HEADING = /^#{1,6}\s+/gm
const EMPHASIS = /(\*\*|__)(.*?)\1/g
const ITALIC = /(\*|_)([^*_\n]+)\1/g
const STRIKE = /~~(.*?)~~/g
const BLOCKQUOTE = /^>\s?/gm
const MULTI_SPACE = /[ \t]+/g
const MULTI_BLANK = /\n{3,}/g

/**
 * Turn markdown into spoken prose: drop fences and tables, unwrap links and
 * emphasis, then optionally cut at `maxChars`.
 * @param markdown - assistant-visible text (never reasoning or tool-call args).
 * @param maxChars - inclusive cap on the returned script; omit to leave it unbounded.
 * @returns the speakable script and whether the cap cut it.
 */
export function toSpeechScript(
  markdown: string,
  maxChars?: number,
): { text: string; truncated: boolean } {
  let text = markdown.replace(FENCED_CODE, ' Code block. ')
  text = text.replace(TILDE_FENCE, ' Code block. ')
  text = text.replace(TABLE_BLOCK, ' Table omitted. ')
  text = text.replace(IMAGE, (_match, alt: string) => alt.trim().length > 0 ? ` ${alt.trim()} ` : ' ')
  text = text.replace(LINK, '$1')
  text = text.replace(AUTOLINK, ' ')
  text = text.replace(INLINE_CODE, '$1')
  text = text.replace(HEADING, '')
  text = text.replace(EMPHASIS, '$2')
  text = text.replace(ITALIC, '$2')
  text = text.replace(STRIKE, '$1')
  text = text.replace(BLOCKQUOTE, '')
  text = text.replace(MULTI_SPACE, ' ')
  text = text.replace(MULTI_BLANK, '\n\n')
  text = text.replace(/[ \t]+\n/g, '\n').trim()
  if (maxChars === undefined || text.length <= maxChars) return { text, truncated: false }
  if (maxChars <= SPEECH_TRUNCATION_CLAUSE.length) {
    return { text: text.slice(0, maxChars), truncated: true }
  }
  const budget = maxChars - SPEECH_TRUNCATION_CLAUSE.length
  return { text: `${text.slice(0, budget).trimEnd()}${SPEECH_TRUNCATION_CLAUSE}`, truncated: true }
}
