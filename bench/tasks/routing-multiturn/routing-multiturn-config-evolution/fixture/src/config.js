import { readFileSync } from 'node:fs'

/** Load settings from the given JSON file path. */
export function loadSettings(filePath) {
  const raw = JSON.parse(readFileSync(filePath, 'utf8'))
  return {
    refreshInterval: raw.refreshInterval ?? 0,
  }
}
