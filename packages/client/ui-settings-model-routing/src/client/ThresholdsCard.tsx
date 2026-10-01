/**
 * The read-only thresholds, from the router's gate read: the global floors,
 * the difficulty band, the judge deadline, the hold, the state cap, each
 * operating point, and how the router gates every engine the registry lists.
 */

import type { ReactNode } from 'react'
import type { ModelRoutingGateView } from '@shres-code/shres-code-model-router/client'
import { RoutingBadge } from './EngineCard.tsx'
import type { ModelRoutingState } from './model.ts'
import { engineCalibration, routerEngine } from './view.ts'
import type { Translate } from './view.ts'
import css from './ModelRoutingSection.module.css'

/** Two decimals, as the gate compares probabilities. */
function probability(value: number): string {
  return value.toFixed(2)
}

/** One read-only value. */
function Tile({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div className={css['tile']}>
      <span className={css['tileLabel']}>{label}</span>
      <span className={css['tileValue']}>{value}</span>
    </div>
  )
}

/** The thresholds card; renders nothing until the router's gate is read. */
export function ThresholdsCard({ state, t }: { state: ModelRoutingState; t: Translate }): ReactNode {
  const gate: ModelRoutingGateView | null = state.gate
  if (gate === null) return null
  const engine = routerEngine(state.engines)
  const labels = new Map((state.engines?.engines ?? []).map(entry => [String(entry.id), entry.label]))
  return (
    <section className={css['card']} aria-label={t('thresholdsTitle')}>
      <div className={css['cardHead']}>
        <div>
          <h3 className={css['cardTitle']}>{t('thresholdsTitle')}</h3>
          <p className={css['sub']}>{t('thresholdsIntro')}</p>
        </div>
        {engine === undefined ? null : <RoutingBadge calibration={engineCalibration(gate, engine)} t={t} />}
      </div>
      <div className={css['tiles']}>
        <Tile label={t('thresholdConfidence')} value={probability(gate.downgradeThreshold)} />
        <Tile label={t('thresholdMargin')} value={probability(gate.downgradeMargin)} />
        <Tile
          label={t('thresholdDifficulty')}
          value={t('thresholdPair', { first: gate.entryScoreCeiling, second: gate.escalateBackScoreThreshold })}
        />
        <Tile label={t('thresholdDeadline')} value={t('thresholdMs', { value: gate.judgmentDeadlineMs.toLocaleString('en-US') })} />
        <Tile label={t('thresholdHold')} value={t('thresholdPair', { first: gate.hold.minSteps, second: gate.hold.maxSteps })} />
        <Tile label={t('thresholdStateCap')} value={t('thresholdChars', { value: gate.stateMaxChars.toLocaleString('en-US') })} />
      </div>
      {gate.engines.length === 0
        ? null
        : (
          <table className={css['table']} aria-label={t('operatingPointsTitle')}>
            <thead>
              <tr>
                <th scope="col">{t('operatingPointEngine')}</th>
                <th scope="col">{t('operatingPointThresholds')}</th>
                <th scope="col">{t('operatingPointRouting')}</th>
              </tr>
            </thead>
            <tbody>
              {gate.engines.map((entry) => {
                const point = gate.operatingPoints.find(candidate => candidate.engine === entry.engine)
                return (
                  <tr key={entry.engine}>
                    <th scope="row" className={css['modelName']}>{labels.get(entry.engine) ?? entry.engine}</th>
                    <td>
                      {point === undefined
                        ? t('thresholdPair', { first: probability(gate.downgradeThreshold), second: `${probability(gate.downgradeMargin)} (${t('operatingPointGlobal')})` })
                        : t('thresholdPair', { first: probability(point.downgradeThreshold), second: probability(point.downgradeMargin) })}
                    </td>
                    <td><RoutingBadge calibration={entry.calibration} t={t} /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
    </section>
  )
}
