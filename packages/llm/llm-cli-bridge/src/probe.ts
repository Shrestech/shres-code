/**
 * Whether a CLI binary is an executable path or a command on PATH.
 * @module @roos-code/roos-code-llm-cli-bridge/probe
 */

import { accessSync, constants } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

/**
 * Whether the process may execute this path.
 * @param candidate - absolute or relative file path.
 * @returns true only for an existing executable.
 */
function canExecute(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK)
  } catch {
    // Absent or non-executable — the only signals accessSync(X_OK) emits.
    return false
  }
  return true
}

/**
 * Resolve the names to look for on one platform (Windows also tries .cmd/.exe).
 * @param binary - configured command or path.
 * @param platform - `process.platform`.
 * @returns candidate basenames or paths.
 */
function candidateNames(binary: string, platform: string): string[] {
  if (platform !== 'win32' || /\.[A-Za-z0-9]+$/.test(binary)) return [binary]
  return [binary, `${binary}.cmd`, `${binary}.exe`, `${binary}.bat`]
}

/**
 * Whether `binary` is an executable file or a command on PATH.
 * @param binary - configured executable name or path.
 * @param pathValue - PATH to scan (default `process.env.PATH`).
 * @param platform - `process.platform` (injected in tests).
 * @returns true when an executable was found.
 */
export function executableOnPath(
  binary: string,
  pathValue: string | undefined = process.env.PATH,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (binary.length === 0) return false
  const names = candidateNames(binary, platform)
  if (isAbsolute(binary) || binary.includes('/') || binary.includes('\\')) {
    return names.some(name => canExecute(name))
  }
  for (const dir of (pathValue ?? '').split(delimiter)) {
    if (dir === '') continue
    for (const name of names) {
      if (canExecute(join(dir, name))) return true
    }
  }
  return false
}
