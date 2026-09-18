// Stage-A packaging for the Electron shell: unpackaged mac-arm64 builds with
// ad-hoc signing and no notarization. ASAR, real signing, and notarization
// belong to stage B; nothing here publishes or updates.
import { join, resolve } from 'node:path'

const APP_ROOT = resolve(import.meta.dirname)
const os = (process.env.SHRES_DESKTOP_TARGET_PLATFORM ?? process.platform) === 'darwin' ? 'mac' : process.platform
const arch = process.env.SHRES_DESKTOP_TARGET_ARCH ?? process.arch
const target = os + '-' + arch
const targetRoot = join(APP_ROOT, '.desktop-build', 'targets', target)

export default {
  appId: 'com.shrestech.shres-code',
  productName: 'Shres Code',
  artifactName: 'shres-code-${version}-${os}-${arch}.${ext}',
  asar: false,
  directories: {
    output: join(targetRoot, 'artifacts'),
  },
  // The shell is fully bundled by tsdown (lib/main.js is self-contained);
  // its package dependencies resolve inside the shres runtime tree instead,
  // so the app payload excludes node_modules and typecheck residue.
  files: ['lib/**/*', 'renderer/**/*', 'package.json', '!node_modules/**', '!lib/types/**'],
  extraResources: [
    // The runtime tree is copied post-build by scripts/finalize-package.mjs:
    // electron-builder's resource copy excludes node_modules contents, which
    // is the whole closure. Stage A ships no Node runtime; the host child
    // runs under the Electron binary via ELECTRON_RUN_AS_NODE.
  ],
  mac: {
    // Ad-hoc signing ('-') keeps the bundle launchable on the build machine
    // without a Developer ID; stage B replaces it with the signing chain.
    identity: '-',
    forceCodeSigning: false,
    notarize: false,
    category: 'public.app-category.developer-tools',
    target: ['dir'],
  },
  publish: null,
}
