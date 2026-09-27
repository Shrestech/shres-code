/**
 * Wire protocol of the `/plugins/events` dev SSE channel — single source for
 * both halves of this package. Frames still cross a wire boundary: the
 * browser half validates them at its JSON parse point; sharing the type keeps
 * the two ends from drifting, not from parsing.
 */

import type {
  BootManifest,
  BootModuleRow,
  BootPluginRow,
  WebBootGraph,
} from '@shres-code/shres-code-client-modules'

/**
 * Validate a graph carried by an SSE frame at the wire boundary. This local
 * copy keeps the HMR browser bundle inside the client purity gate; the shell's
 * boot parser in client-modules validates the same fields before first boot.
 * @param wire - untrusted graph payload from the host event stream.
 * @returns normalized module and plugin views.
 */
export function parseBootManifest(wire: unknown): BootManifest {
  if (typeof wire !== 'object' || wire === null) {
    throw new Error('client-hmr: graph payload is missing or not an object')
  }
  const graph = wire as Record<string, unknown>
  if (typeof graph.rev !== 'string') throw new Error('client-hmr: graph rev must be a string')
  if (!Array.isArray(graph.entries)) throw new Error('client-hmr: graph entries must be an array')
  const modules: BootModuleRow[] = []
  const plugins: BootPluginRow[] = []
  const seen = new Set<string>()
  for (const value of graph.entries as unknown[]) {
    if (typeof value !== 'object' || value === null) throw new Error('client-hmr: graph entry is not an object')
    const row = value as Record<string, unknown>
    const where = typeof row.id === 'string' ? JSON.stringify(row.id) : JSON.stringify(row)
    if (typeof row.id !== 'string' || typeof row.url !== 'string' || typeof row.rev !== 'string') {
      throw new Error(`client-hmr: graph entry ${where} must carry string id/url/rev`)
    }
    if (seen.has(row.id)) throw new Error(`client-hmr: graph entry ${where} is duplicated`)
    seen.add(row.id)
    if (row.inject !== undefined && (!Array.isArray(row.inject) || row.inject.some(item => typeof item !== 'string'))) {
      throw new Error(`client-hmr: graph entry ${where} inject must be a string array`)
    }
    if (row.immediately !== undefined && typeof row.immediately !== 'boolean') {
      throw new Error(`client-hmr: graph entry ${where} immediately must be a boolean`)
    }
    modules.push({ id: row.id, url: row.url, rev: row.rev })
    plugins.push({
      id: row.id,
      inject: row.inject === undefined ? [] : [...row.inject as string[]],
      immediately: row.immediately === true,
    })
  }
  return { rev: graph.rev, modules, plugins }
}

/** One SSE frame: the full graph on connect, or one rebuilt bundle notice. */
export type PluginsEventFrame =
  | { type: 'graph'; graph: WebBootGraph }
  | { type: 'rebuilt'; id: string; rev: string }

/** System SSE endpoint pushing graph/rebuilt frames (wire protocol constant). */
export const EVENTS_ENDPOINT = '/plugins/events'
