import { describe, expect, it } from 'vitest'
import { SPEECH_TRUNCATION_CLAUSE, toSpeechScript } from '../src/script.ts'

describe('toSpeechScript', () => {
  it('unwraps headings, emphasis, and inline code', () => {
    expect(toSpeechScript('## Hello **world** and `pnpm`').text).toBe('Hello world and pnpm')
  })

  it('replaces tilde-fenced code with a spoken placeholder', () => {
    expect(toSpeechScript('Before\n~~~\nsecret\n~~~\nAfter').text).not.toContain('secret')
  })

  it('replaces fenced code with a spoken placeholder', () => {
    const { text } = toSpeechScript('Before\n```ts\nconst x = 1\n```\nAfter')
    expect(text).toMatch(/Before\s+Code block\.\s+After/)
    expect(text).not.toContain('const')
  })

  it('replaces a markdown table with a spoken placeholder', () => {
    const { text } = toSpeechScript('See\n| a | b |\n| --- | --- |\n| 1 | 2 |\ndone')
    expect(text).toContain('Table omitted.')
    expect(text).not.toContain('| a |')
  })

  it('uses a link label and drops the URL', () => {
    expect(toSpeechScript('See [docs](https://example.com/path) now').text).toBe('See docs now')
  })

  it('uses image alt text and drops the URL', () => {
    expect(toSpeechScript('Look ![chart](https://example.com/a.png) here').text).toBe('Look chart here')
  })

  it('drops an image with empty alt text', () => {
    expect(toSpeechScript('Look ![](https://example.com/a.png) here').text).toBe('Look here')
  })

  it('returns empty text for whitespace-only input', () => {
    expect(toSpeechScript('   \n\n').text).toBe('')
    expect(toSpeechScript('```\n\n```').text).toBe('Code block.')
  })

  it('truncates at maxChars and appends the omission clause', () => {
    const { text, truncated } = toSpeechScript('abcdefghijklmnopqrstuvwxyz0123456789', 30)
    expect(truncated).toBe(true)
    expect(text.endsWith(SPEECH_TRUNCATION_CLAUSE)).toBe(true)
    expect(text.length).toBe(30)
  })

  it('slices without the omission clause when the cap is shorter than the clause', () => {
    const { text, truncated } = toSpeechScript('abcdefghijklmnopqrstuvwxyz', 4)
    expect(truncated).toBe(true)
    expect(text).toBe('abcd')
  })

  it('unwraps italics, strike, and block quotes', () => {
    expect(toSpeechScript('> *hi* ~~bye~~').text).toBe('hi bye')
  })

  it('does not truncate when under the cap', () => {
    const { text, truncated } = toSpeechScript('short', 100)
    expect(truncated).toBe(false)
    expect(text).toBe('short')
  })
})
