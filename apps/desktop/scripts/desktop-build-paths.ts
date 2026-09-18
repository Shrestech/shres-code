/** Resolve build-owned desktop paths without sharing mutable state across release targets. */

import { join, resolve } from 'node:path'

const APP_ROOT = resolve(import.meta.dirname, '..')
const BUILD_ROOT = join(APP_ROOT, '.desktop-build')

/** Targets this pipeline can prepare; stage A ships mac-arm64. */
const SUPPORTED_TARGETS = new Set(['mac-arm64', 'mac-x64'])
type DesktopBuildTarget = 'mac-arm64' | 'mac-x64'

/** Every mutable directory owned by one release target plus the shared download cache. */
export interface DesktopTargetBuildPaths {
  readonly root: string
  readonly artifacts: string
  readonly runtime: string
  readonly packageSet: string
  /** Materialized production runtime project; electron-builder ships it as Contents/Resources/shres. */
  readonly dsh: string
  readonly dshPnpm: string
  readonly nodeExtract: string
  readonly packedDsh: string
  readonly packedVendor: string
  readonly packedLandlock: string
  readonly downloads: string
}

/**
 * Resolve the fixed build target selected by a packaging environment.
 * @param env - packaging environment.
 * @param hostPlatform - build-host platform used when no target override exists.
 * @param hostArch - build-host architecture used when no target override exists.
 * @returns the supported target name.
 */
export function resolveDesktopBuildTarget(
  env: NodeJS.ProcessEnv = process.env,
  hostPlatform: NodeJS.Platform = process.platform,
  hostArch: string = process.arch,
): DesktopBuildTarget {
  const platform = env.SHRES_DESKTOP_TARGET_PLATFORM ?? env.npm_config_platform ?? hostPlatform
  const arch = env.SHRES_DESKTOP_TARGET_ARCH ?? env.npm_config_arch ?? hostArch
  const os = platform === 'darwin' ? 'mac' : platform
  const target = os + '-' + arch
  if (!SUPPORTED_TARGETS.has(target)) {
    throw new Error('desktop build paths: unsupported target ' + target)
  }
  return target as DesktopBuildTarget
}

/**
 * Return the mutable preparation and artifact directories owned by one release target.
 * @param target - supported target name.
 * @returns the target's paths, with the shared immutable download cache.
 */
export function desktopTargetBuildPaths(target: DesktopBuildTarget): DesktopTargetBuildPaths {
  if (!SUPPORTED_TARGETS.has(target)) {
    throw new Error('desktop build paths: unsupported target ' + String(target))
  }
  const root = join(BUILD_ROOT, 'targets', target)
  const packed = join(root, 'packed')
  return {
    root,
    artifacts: join(root, 'artifacts'),
    runtime: join(root, 'runtime'),
    packageSet: join(root, 'package-set'),
    dsh: join(root, 'shres'),
    dshPnpm: join(root, 'dsh-pnpm'),
    nodeExtract: join(root, 'node-extract'),
    packedDsh: join(packed, 'dsh'),
    packedVendor: join(packed, 'vendor'),
    packedLandlock: join(packed, 'landlock'),
    downloads: join(BUILD_ROOT, 'downloads'),
  }
}

/**
 * Resolve the paths owned by the target selected in a packaging environment.
 * @param env - packaging environment.
 * @param hostPlatform - build-host platform used when no target override exists.
 * @param hostArch - build-host architecture used when no target override exists.
 * @returns the selected target's paths.
 */
export function resolveDesktopTargetBuildPaths(
  env: NodeJS.ProcessEnv = process.env,
  hostPlatform: NodeJS.Platform = process.platform,
  hostArch: string = process.arch,
): DesktopTargetBuildPaths {
  return desktopTargetBuildPaths(resolveDesktopBuildTarget(env, hostPlatform, hostArch))
}
