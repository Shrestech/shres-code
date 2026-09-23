import { describe, expect, it } from 'vitest'
import { desktopRuntimeFileExclusion } from '../scripts/runtime-file-policy.ts'

const target = { platform: 'darwin' as const, arch: 'arm64' }

describe('desktop runtime file policy', () => {
  it('keeps Koffi JavaScript entrypoints and removes native sources', () => {
    expect(desktopRuntimeFileExclusion('koffi/src', target, true)).toBeUndefined()
    expect(desktopRuntimeFileExclusion('koffi/src/koffi', target, true)).toBeUndefined()
    expect(desktopRuntimeFileExclusion('koffi/src/koffi/index.js', target)).toBeUndefined()
    expect(desktopRuntimeFileExclusion('koffi/src/koffi/src/static.cjs', target)).toBeUndefined()
    expect(desktopRuntimeFileExclusion('koffi/src/koffi/src/abi/arm64.cc', target)).toBe('Koffi native sources')
    expect(desktopRuntimeFileExclusion('koffi/src/koffi/CMakeLists.txt', target)).toBe('Koffi native sources')
  })
})
