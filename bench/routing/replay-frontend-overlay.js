/**
 * Overlay for launcher-hosted replay: disable one-shot, pin persistence, and
 * insert the replay plugin. Judge mode decides Laya and which engine is inserted.
 * @module
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const benchRoot = dirname(dirname(fileURLToPath(import.meta.url)))
export const REPLAY_FRONTEND_PLUGIN_PATH = join(benchRoot, 'routing', 'replay-frontend-plugin.mjs')
export const REPLAY_SCRIPTED_JUDGE_PATH = join(benchRoot, 'routing', 'replay-scripted-judge.mjs')
export const REPLAY_SCRIPTED_FITTING_JUDGE_PATH = join(benchRoot, 'routing', 'replay-scripted-fitting-judge.mjs')

/**
 * @param {{ pluginPath?: string, judgePath?: string, fittingJudgePath?: string, fittingJudgeConfig?: object, sinkUrl: string, sessionLogRoot: string, job: string, out: string, judgeMode?: 'off'|'composition'|'fixture' }} input
 * @returns {string}
 */
export function renderReplayFrontendOverlay({
  pluginPath, judgePath, fittingJudgePath, fittingJudgeConfig, sinkUrl, sessionLogRoot, job, out,
  judgeMode = 'off',
}) {
  const plugin = pluginPath ?? REPLAY_FRONTEND_PLUGIN_PATH
  const placeholder = judgePath ?? REPLAY_SCRIPTED_JUDGE_PATH
  const inserts = []
  if (judgeMode === 'off') {
    inserts.push('    - id: bench-replay-scripted-judge', '      name: ' + JSON.stringify(placeholder))
  }
  if (judgeMode === 'fixture') {
    inserts.push(
      '    - id: bench-replay-scripted-fitting-judge',
      '      name: ' + JSON.stringify(fittingJudgePath),
    )
    if (fittingJudgeConfig !== undefined) {
      inserts.push('      config: ' + JSON.stringify(fittingJudgeConfig))
    }
  }
  inserts.push(
    '    - id: bench-replay-frontend',
    '      name: ' + JSON.stringify(plugin),
    '      config:',
    '        job: ' + JSON.stringify(job),
    '        out: ' + JSON.stringify(out),
  )
  const disableLaya = judgeMode === 'composition' ? [] : [
    '- id: judgment-laya',
    '  disabled: true',
  ]
  return [
    '# Generated: disable one-shot; insert replay frontend for the selected judge mode.',
    '- id: headless-runner',
    '  disabled: true',
    '- id: headless-startup',
    '  disabled: true',
    ...disableLaya,
    '- id: session-persistence-jsonl',
    '  config:',
    '    root: ' + JSON.stringify(sessionLogRoot),
    '    compression: none',
    '- id: llm-deepseek',
    '  config:',
    '    baseURL: ' + JSON.stringify(sinkUrl),
    '- insert:',
    ...inserts,
    '',
  ].join('\n')
}
