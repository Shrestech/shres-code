import { describe, expect, it } from 'vitest'
import { resolveBrowserSkillConfig } from '../src/config.ts'

describe('resolveBrowserSkillConfig', () => {
  it('fills the measured defaults', () => {
    const config = resolveBrowserSkillConfig()
    expect(config.healthIntervalMs).toBe(5_000)
    expect(config.healthMissLimit).toBe(2)
    expect(config.commandTimeoutMs).toBe(10_000)
    expect(config.daemonReadyTimeoutMs).toBe(30_000)
    expect(config.browserConnectTimeoutMs).toBe(30_000)
    expect(config.downloadTimeoutMs).toBe(60_000)
    expect(config.maxDownloadBytes).toBe(67_108_864)
    expect(config.artifactBaseUrl).toBeUndefined()
    expect(config.updateManifestUrl).toBeUndefined()
  })

  it('rejects timer overflow and unsafe integer limits', () => {
    for (const key of ['healthIntervalMs', 'commandTimeoutMs', 'daemonReadyTimeoutMs', 'browserConnectTimeoutMs', 'downloadTimeoutMs'] as const) {
      expect(() => resolveBrowserSkillConfig({ [key]: 2_147_483_648 })).toThrow(key)
      expect(resolveBrowserSkillConfig({ [key]: 2_147_483_647 })[key]).toBe(2_147_483_647)
    }
    expect(() => resolveBrowserSkillConfig({ maxDownloadBytes: Number.MAX_SAFE_INTEGER + 1 })).toThrow('maxDownloadBytes')
    expect(() => resolveBrowserSkillConfig({ healthMissLimit: Number.POSITIVE_INFINITY })).toThrow('healthMissLimit')
  })

  it('refuses embedded URL credentials without echoing the supplied URL', () => {
    for (const url of ['https://example-user@example.test/', 'https://:example-password@example.test/']) {
      let message = ''
      try { resolveBrowserSkillConfig({ artifactBaseUrl: url }) } catch (error) { message = String(error) }
      expect(message).toContain('must not contain credentials')
      expect(message).not.toContain(url)
    }
  })

  it('parses URL fields', () => {
    const config = resolveBrowserSkillConfig({
      artifactBaseUrl: 'http://127.0.0.1:9/logs',
      updateManifestUrl: 'https://example.test/version.json',
    })
    expect(config.artifactBaseUrl?.href).toBe('http://127.0.0.1:9/logs')
    expect(config.updateManifestUrl?.href).toBe('https://example.test/version.json')
  })

  it('fails loud with the field name on a non-integer', () => {
    expect(() => resolveBrowserSkillConfig({ healthIntervalMs: 1.5 })).toThrow(/healthIntervalMs/)
    expect(() => resolveBrowserSkillConfig({ healthMissLimit: 0 })).toThrow(/healthMissLimit/)
    expect(() => resolveBrowserSkillConfig({ maxDownloadBytes: Number.NaN })).toThrow(/maxDownloadBytes/)
  })

  it('fails loud when the command timeout cannot cover the status wait', () => {
    // bsk status waits five seconds for a browser plus a two-second IPC
    // slack before answering; a smaller deadline kills healthy calls.
    expect(() => resolveBrowserSkillConfig({ commandTimeoutMs: 7_000 })).toThrow(/commandTimeoutMs/)
    expect(resolveBrowserSkillConfig({ commandTimeoutMs: 8_000 }).commandTimeoutMs).toBe(8_000)
  })

  it('rejects non-http URL schemes and relative strings', () => {
    expect(() => resolveBrowserSkillConfig({ artifactBaseUrl: 'ftp://example.test' })).toThrow(/artifactBaseUrl/)
    expect(() => resolveBrowserSkillConfig({ updateManifestUrl: '/relative/path' })).toThrow(/updateManifestUrl/)
  })
})
