/** macOS installers include the complete runtime before signing and notarization. */
import { join, resolve } from 'node:path'

const APP_ROOT = resolve(import.meta.dirname)
const release = process.env.SHRES_DESKTOP_RELEASE === '1'
if (process.env.SHRES_DESKTOP_RELEASE && !release) {
  throw new Error('desktop packaging: SHRES_DESKTOP_RELEASE must be 1 or unset')
}
if (release) {
  for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) {
    if (!process.env[name]) throw new Error(`desktop release: missing ${name}`)
  }
}
const platform = process.env.SHRES_DESKTOP_TARGET_PLATFORM ?? process.platform
const arch = process.env.SHRES_DESKTOP_TARGET_ARCH ?? process.arch
if (platform !== 'darwin' || arch !== 'arm64' || process.platform !== platform || process.arch !== arch) {
  throw new Error('desktop packaging: build mac-arm64 on a native Apple Silicon macOS host')
}
const targetRoot = join(APP_ROOT, '.desktop-build', 'targets', 'mac-arm64')

export default {
  appId: 'com.shrestech.shres-code',
  productName: 'Shres Code',
  artifactName: 'shres-code-${version}-${os}-${arch}.${ext}',
  asar: false,
  npmRebuild: false,
  forceCodeSigning: release,
  directories: { output: join(targetRoot, 'artifacts') },
  // Shell imports are bundled; production dependencies live in Resources/shres.
  files: ['lib/**/*', 'renderer/**/*', 'package.json', '!node_modules/**', '!lib/types/**'],
  afterPack: './scripts/finalize-package.mjs',
  mac: {
    ...(release ? {} : { identity: '-' }),
    hardenedRuntime: release,
    notarize: release,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    category: 'public.app-category.developer-tools',
    target: [{ target: 'dmg', arch: ['arm64'] }, { target: 'zip', arch: ['arm64'] }],
  },
  dmg: { sign: release, writeUpdateInfo: false },
  publish: null,
}
