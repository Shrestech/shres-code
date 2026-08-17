/**
 * Internal platform-profile builders for the local sandbox provider.
 *
 * @module @shres-code/shres-code-sandbox-local/profiles
 */

import { join } from 'node:path'
import { grantArgs as landlockGrantArgs } from '@shres-code/node-addon-landlock-run'
import { resolveShresHome } from '@shres-code/shres-code-home-paths'
import { sandboxNetwork, writableRoots } from '@shres-code/shres-code-sandbox'
import type { SandboxPolicy } from '@shres-code/shres-code-sandbox'

/** Home credentials document the in-process fs fence also denies. */
function credentialsReadDenyPath(): string {
  return join(resolveShresHome(), '.credentials.yaml')
}

/**
 * Build the bwrap profile arguments for one file-effect policy.
 * Default `network: deny` unshares the net namespace (`--unshare-net`);
 * `network: allow` leaves the host network visible.
 * @param policy - file-effect policy to express as bwrap mounts.
 * @returns profile arguments before the trailing separator and command argv.
 */
export function bwrapProfileArgs(policy: SandboxPolicy): string[] {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--die-with-parent']
  args.push('--bind', '/dev/null', credentialsReadDenyPath())
  if (sandboxNetwork(policy) === 'deny') args.push('--unshare-net')
  if (policy.mode === 'workspace-write') {
    args.push('--tmpfs', '/tmp')
    args.push('--bind', policy.workspaceRoot, policy.workspaceRoot)
  }
  return args
}

/**
 * Build the Landlock launcher grants for one file-effect policy. Filesystem
 * grants are unchanged — Landlock is allow-list only, so a `/` read grant
 * cannot subtract `$SHRES_HOME/.credentials.yaml` (Seatbelt/bwrap + `ctx.fs`
 * / search fences close that path). `network: allow` lifts the launcher's
 * default TCP deny via `--allow-net`.
 * @param policy - file-effect policy to express as Landlock allow-list grants.
 * @returns launcher grant arguments before the trailing separator and command argv.
 */
export function landlockProfileArgs(policy: SandboxPolicy): string[] {
  const readWrite = ['/dev/null']
  if (policy.mode === 'workspace-write') {
    readWrite.push('/tmp', policy.workspaceRoot)
  }
  return landlockGrantArgs({
    readOnly: ['/'],
    readWrite,
    ...sandboxNetwork(policy) === 'allow' ? { allowNetwork: true } : {},
  })
}

/** Quote one path as an SBPL string literal. */
function sbplString(path: string): string {
  return `"${path.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`
}

/**
 * Build the sandbox-exec arguments and SBPL profile for one policy. The
 * writable roots come from the shared {@link writableRoots} helper (canonical,
 * deduplicated) so the Seatbelt grant and the in-process fs fence
 * (`@shres-code/shres-code-fs-sandbox`) can never drift apart. Default
 * `network: deny` adds `(deny network-outbound)`.
 * @param policy - file-effect policy to express as an SBPL profile.
 * @returns sandbox-exec arguments before the trailing separator and command argv.
 */
export function seatbeltProfileArgs(policy: SandboxPolicy): string[] {
  const forms = ['(version 1)', '(allow default)', '(deny file-write*)', `(allow file-write* (literal ${sbplString('/dev/null')}))`]
  const credentials = credentialsReadDenyPath()
  forms.push(`(deny file-read* (literal ${sbplString(credentials)}) (subpath ${sbplString(credentials)}))`)
  if (sandboxNetwork(policy) === 'deny') forms.push('(deny network-outbound)')
  const roots = writableRoots(policy)
  if (roots.length > 0) {
    forms.push(`(allow file-write* ${roots.map(root => `(subpath ${sbplString(root)})`).join(' ')})`)
  }
  return ['-p', forms.join(' ')]
}
