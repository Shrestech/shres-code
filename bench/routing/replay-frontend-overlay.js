/**
 * Overlay for launcher-hosted replay: disable one-shot and Laya, insert the
 * scripted judge and the replay frontend plugin. Adapter endpoints are
 * redirected by the caller the same way preflight does.
 * @module
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const benchRoot = dirname(dirname(fileURLToPath(import.meta.url)))
export const REPLAY_FRONTEND_PLUGIN_PATH = join(benchRoot, 'routing', 'replay-frontend-plugin.mjs')
export const REPLAY_SCRIPTED_JUDGE_PATH = join(benchRoot, 'routing', 'replay-scripted-judge.mjs')

/**
 * @param {{ pluginPath?: string, judgePath?: string, sinkUrl: string }} input
 * @returns {string}
 */
export function renderReplayFrontendOverlay({ pluginPath, judgePath, sinkUrl }) {
  const plugin = pluginPath ?? REPLAY_FRONTEND_PLUGIN_PATH
  const judge = judgePath ?? REPLAY_SCRIPTED_JUDGE_PATH
  return [
    '# Generated: disable one-shot and Laya; insert scripted judge + replay frontend.',
    '- id: headless-runner',
    '  disabled: true',
    '- id: headless-startup',
    '  disabled: true',
    '- id: judgment-laya',
    '  disabled: true',
    '- id: llm-deepseek',
    '  config:',
    '    baseURL: ' + JSON.stringify(sinkUrl),
    '- insert:',
    '    - id: bench-replay-scripted-judge',
    '      name: ' + JSON.stringify(judge),
    '    - id: bench-replay-frontend',
    '      name: ' + JSON.stringify(plugin),
    '',
  ].join('\n')
}
