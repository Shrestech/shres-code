/** Paths of an installed production npm tree that the immutable Desktop runtime omits. */

/** Package-manager bookkeeping that never reaches a runtime. */
const PACKAGE_MANAGER_ENTRIES: readonly string[] = ['.bin', '.pnpm', '.modules.yaml', '.pnpm-workspace-state-v1.json']

/** One family of sibling packages that each ship a payload for a single platform. */
interface PerPlatformPackage {
  /** Package name prefix the family shares. */
  readonly prefix: string
  /** The member for the target's own platform. */
  readonly forTarget: (target: { readonly platform: NodeJS.Platform; readonly arch: string }) => string
  /** Omission reason reported for another platform's member. */
  readonly reason: string
}

/** Sibling package families installed beside their platform-independent package. */
const PER_PLATFORM_PACKAGES: readonly PerPlatformPackage[] = [
  {
    prefix: '@esbuild/',
    forTarget: target => `@esbuild/${target.platform}-${target.arch}`,
    reason: 'esbuild other platform',
  },
  {
    prefix: '@vscode/ripgrep-',
    forTarget: target => `@vscode/ripgrep-${target.platform}-${target.arch}`,
    reason: 'ripgrep other platform',
  },
  {
    prefix: '@koromix/koffi-',
    forTarget: target => `@koromix/koffi-${target.platform}-${target.arch}`,
    reason: 'Koffi other platform',
  },
  {
    prefix: '@shres-code/node-addon-landlock-run-linux-',
    forTarget: target => `@shres-code/node-addon-landlock-run-linux-${target.arch}`,
    reason: 'landlock other platform',
  },
]

/**
 * Identify build and diagnostic files omitted from the immutable Desktop runtime.
 * Unrecognized assets and target runtime binaries are retained. Paths name the copied
 * node_modules tree, including nested package containers.
 * @param path - Path relative to the production node_modules directory.
 * @param target - Platform and architecture of the bundled Node executable.
 * @returns Omission reason, or undefined when the entry must be copied.
 */
export function desktopRuntimeFileExclusion(
  path: string,
  target: { readonly platform: NodeJS.Platform; readonly arch: string },
): string | undefined {
  const parts = path.split(/[\\/]/u)
  if (parts.some(part => PACKAGE_MANAGER_ENTRIES.includes(part))) return 'package-manager metadata'
  const file = parts.at(-1) ?? ''
  if (/\.(?:[cm]?[jt]s|css)\.map$/u.test(file)) return 'source map'
  if (/\.d\.[cm]?ts$/u.test(file)) return 'TypeScript declaration'
  if (/\.tsbuildinfo$/u.test(file)) return 'TypeScript build cache'
  const packageParts = parts.slice(parts.lastIndexOf('node_modules') + 1)
  const nameParts = packageParts[0]?.startsWith('@') === true ? 2 : 1
  const name = packageParts.slice(0, nameParts).join('/')
  const entry = packageParts.slice(nameParts).join('/')
  for (const family of PER_PLATFORM_PACKAGES) {
    if (name.startsWith(family.prefix) && name !== family.forTarget(target)) return family.reason
  }
  if (name === 'node-pty') {
    if (entry === 'prebuilds' || entry.startsWith('prebuilds/')) {
      const prebuild = packageParts[nameParts + 1]
      if (prebuild !== undefined && prebuild !== `${target.platform}-${target.arch}`) return 'node-pty other platform'
      if (file.endsWith('.pdb')) return 'node-pty debug symbols'
    }
    if (/^build\/(?:Release|Debug)\/(?:\.deps|obj\.target)(?:\/|$)/u.test(entry)) return 'node-pty compiler output'
  }
  if (name === 'koffi') {
    if (entry === 'src' || entry.startsWith('src/')) return 'Koffi native sources'
    if (entry === 'lib/native' || entry.startsWith('lib/native/')) return 'Koffi native sources'
    if (entry === 'vendor' || entry.startsWith('vendor/')) return 'Koffi build headers'
  }
  if (name === '@koromix/koffi-win32-x64' && entry === 'win32_x64/koffi.lib') return 'Koffi import library'
  if (name === 'onnxruntime-node') {
    const payloadKey = /^bin\/napi-v\d+\/([^/]+)\/([^/]+)(?:\/|$)/u.exec(entry)?.slice(1).join('-')
    if (payloadKey !== undefined && payloadKey !== `${target.platform}-${target.arch}`) {
      return 'onnxruntime-node other platform'
    }
    if (entry === 'script' || entry.startsWith('script/')) return 'onnxruntime-node build script'
  }
  if (name === '@shres-code/node-addon-landlock-run' && (entry === 'src' || entry.startsWith('src/'))) return 'landlock C source'
  return undefined
}
