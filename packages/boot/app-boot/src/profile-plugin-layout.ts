/**
 * The profile's installed node_modules layout, read from pnpm's own
 * `node_modules/.modules.yaml` record. Managed installation inspects package
 * trees on the assumption that pnpm's hoisted linker materialized them as
 * real directories; under another linker an already-present store bucket can
 * be linked into a new plugin without any tree change, so managed
 * installation refuses every profile whose recorded layout is not hoisted.
 * The record is read as a file only; nothing in it is executed.
 * @module @shres-code/shres-code-app-boot/profile-plugin-layout
 */

import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { load } from 'js-yaml'
import type { InstallRefusal } from './profile-plugin-types.ts'

/** pnpm's installed-layout record, relative to the profile directory. */
export const MODULES_RECORD = join('node_modules', '.modules.yaml')

/** The layout managed installation accepts. */
const SUPPORTED_LINKER = 'hoisted'

/** What the profile's installed-layout record says. */
export type ModulesLayout =
  | { readonly kind: 'absent' }
  | { readonly kind: 'recorded'; readonly nodeLinker: string | null }
  | { readonly kind: 'unreadable'; readonly detail: string }

/**
 * Read the installed-layout record without following a link or opening a
 * special file.
 * @param profileDir - the profile directory.
 * @returns the record's absence, its `nodeLinker` (null when missing or not a string), or why it could not be read.
 */
export async function readModulesLayout(profileDir: string): Promise<ModulesLayout> {
  const path = join(profileDir, MODULES_RECORD)
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' }
    return { kind: 'unreadable', detail: String(error) }
  }
  if (!info.isFile()) return { kind: 'unreadable', detail: `${MODULES_RECORD} is not a regular file` }
  let parsed: unknown
  try {
    parsed = load(await readFile(path, 'utf8'))
  } catch (error) {
    return { kind: 'unreadable', detail: String(error) }
  }
  const linker = typeof parsed === 'object' && parsed !== null ? (parsed as { nodeLinker?: unknown }).nodeLinker : undefined
  return { kind: 'recorded', nodeLinker: typeof linker === 'string' ? linker : null }
}

/**
 * The refusal for a layout managed installation does not support, if any.
 * Before an install an absent record is a fresh profile and is accepted;
 * after pnpm ran, the record must exist.
 * @param layout - the record as read.
 * @param phase - `'before'` the install mutates anything, or `'after'` pnpm's add.
 * @returns an `unsupported-layout` refusal, or undefined when the layout is hoisted (or absent before install).
 */
export function layoutRefusal(layout: ModulesLayout, phase: 'before' | 'after'): InstallRefusal | undefined {
  switch (layout.kind) {
    case 'absent':
      return phase === 'before' ? undefined : {
        code: 'unsupported-layout', nodeLinker: null,
        detail: `pnpm wrote no ${MODULES_RECORD}; the installed layout cannot be verified as ${SUPPORTED_LINKER}`,
      }
    case 'unreadable':
      return { code: 'unsupported-layout', nodeLinker: null, detail: `${MODULES_RECORD} could not be read: ${layout.detail}` }
    case 'recorded':
      if (layout.nodeLinker === SUPPORTED_LINKER) return undefined
      return {
        code: 'unsupported-layout', nodeLinker: layout.nodeLinker,
        detail: layout.nodeLinker === null
          ? `${MODULES_RECORD} records no nodeLinker; managed installation requires ${SUPPORTED_LINKER}`
          : `the profile's node_modules uses the ${layout.nodeLinker} linker; managed installation requires ${SUPPORTED_LINKER}`,
      }
  }
}
