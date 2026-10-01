/**
 * The decision drill-down: one logged decision, fetched through the
 * `modelRouting.decision` read, with its engine facts, the route question and
 * option probabilities, confidence and margin against the configured
 * thresholds, difficulty against the entry and exit scores, the ordered gate
 * path with its first failing check, candidate eligibility, the state sent to
 * the judge, and the streak facts.
 */
import { Fragment, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { promptTokens } from '@shres-code/shres-code-llm/usage'
import type { ModelRoutingDecisionDetail } from '@shres-code/shres-code-model-router/client'
import {
  decisionThresholds, gatePath, routeMargin, routeOptions, routeQuestion, thresholdSourceLabel, thresholdValueLabel,
  type RoutingTranslate,
} from './derive.ts'
import { formatMs, formatScore, formatTokens } from './format.ts'
import css from './DecisionDrawer.module.css'

/** Props of the drill-down drawer. */
export interface DecisionDrawerProps {
  /** Seq of the `model-routing/decision` event to show. */
  seq: number
  /** Fetch one decision with the configured gate. */
  loadDecision: (seq: number) => Promise<ModelRoutingDecisionDetail>
  /** Close the drawer. */
  onClose: () => void
  /** Reveal this decision in Trajectory, when Trajectory is available. */
  onTrajectory?: (() => void) | undefined
  /** The view's translate. */
  t: RoutingTranslate
}

type Load =
  | { kind: 'loading' }
  | { kind: 'loaded'; detail: ModelRoutingDecisionDetail }
  | { kind: 'failed'; message: string }

/**
 * The drill-down drawer for one decision.
 * @param props - the decision seq, loader, handoffs, and translate.
 * @returns the drawer.
 */
export function DecisionDrawer({ seq, loadDecision, onClose, onTrajectory, t }: DecisionDrawerProps) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [showState, setShowState] = useState(false)
  const closeRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    let live = true
    setLoad({ kind: 'loading' })
    setShowState(false)
    loadDecision(seq).then(
      (detail) => { if (live) setLoad({ kind: 'loaded', detail }) },
      (reason: unknown) => { if (live) setLoad({ kind: 'failed', message: reason instanceof Error ? reason.message : String(reason) }) },
    )
    return () => { live = false }
  }, [seq, attempt, loadDecision])

  useEffect(() => { closeRef.current?.focus() }, [seq])

  return (
    <aside
      className={css.drawer}
      role="dialog"
      aria-labelledby="routing-decision-title"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        onClose()
      }}
    >
      <div className={css.actions}>
        {onTrajectory !== undefined && <button type="button" className={css.button} onClick={onTrajectory}>{t('drill.trajectory')}</button>}
        <button type="button" ref={closeRef} className={css.button} onClick={onClose}>{t('drill.close')}</button>
      </div>
      {load.kind === 'loading' && <p id="routing-decision-title" className={css.muted}>{t('drill.loading', { seq })}</p>}
      {load.kind === 'failed' && (
        <div role="alert">
          <p id="routing-decision-title" className={css.error}>{t('drill.failed', { message: load.message })}</p>
          <button type="button" className={css.button} onClick={() => { setAttempt(attempt + 1) }}>{t('drill.retry')}</button>
        </div>
      )}
      {load.kind === 'loaded' && <DecisionBody detail={load.detail} showState={showState} onShowState={() => { setShowState(true) }} t={t} />}
    </aside>
  )
}

/** The loaded drill-down content. */
function DecisionBody({ detail, showState, onShowState, t }: {
  detail: ModelRoutingDecisionDetail
  showState: boolean
  onShowState: () => void
  t: RoutingTranslate
}) {
  const { decision, gate } = detail
  const thresholds = decisionThresholds(detail)
  const thresholdLabel = (value: number): string => thresholdValueLabel(thresholds, value, t)
  const path = gatePath(decision.reason, decision.candidateEligibility !== undefined)
  const first = path.find(check => check.first)
  const options = routeOptions(decision)
  const question = routeQuestion(decision)
  const margin = routeMargin(decision)
  const best = options.find(option => option.option !== 'keep-current')
  const confidence = decision.route === undefined
    ? undefined
    : decision.route.choice === 'keep-current' ? best?.probability : decision.route.confidence
  const levels = Math.max(1, gate.difficultyLevels.length - 1)
  const assessments = decision.candidateEligibility?.assessments ?? []
  const input = decision.judgmentInput
  const projection = decision.stateProjection
  // Per-question head tokens, from the logged fit only: sequenceTokens[i]
  // minus stateTokens against limits.maxHeadTokens. A fit that recorded no
  // limits, or fewer measurements than questions, contributes no row - facts
  // the log lacks stay unavailable rather than reading as zero.
  const heads = input === undefined ? [] : input.sequenceTokens
    .map((sequenceTokens, index) => ({
      question: decision.judgmentQuestions?.[index]?.id ?? String(index + 1),
      tokens: sequenceTokens - input.stateTokens,
      max: input.limits.maxHeadTokens,
    }))
    .filter(head => Number.isFinite(head.tokens) && Number.isFinite(head.max))
  return (
    <>
      <span className={css.outcome} data-outcome={decision.outcome}>{decision.outcome}</span>
      <h2 id="routing-decision-title" className={css.title}>{t('drill.title', { turn: detail.turn, step: detail.step, reason: decision.reason })}</h2>
      <p className={css.lead}>
        {first === undefined ? t('drill.path.none') : t('drill.path.first', { check: t(`check.${first.id}`) })}
      </p>
      <p className={css.muted}><time dateTime={new Date(detail.time).toISOString()}>{new Date(detail.time).toISOString().replace('T', ' ').slice(0, 19)} UTC</time></p>

      <h3 className={css.section}>{t('drill.engine')}</h3>
      <dl className={css.facts}>
        <dt>{t('drill.engine.name')}</dt><dd>{[decision.engine, decision.model].filter(Boolean).join(' · ') || t('drill.none')}</dd>
        {decision.engineId !== undefined && (<><dt>{t('drill.engine.id')}</dt><dd className={css.mono}>{decision.engineId}</dd></>)}
        <dt>{t('drill.engine.latency')}</dt>
        <dd>{decision.latencyMs === undefined ? t('drill.none') : t('drill.engine.latencyValue', { latency: formatMs(decision.latencyMs), deadline: formatMs(gate.judgmentDeadlineMs) })}</dd>
        {decision.eligibilityMs !== undefined && (<><dt>{t('drill.engine.eligibility')}</dt><dd>{formatMs(decision.eligibilityMs)}</dd></>)}
        {decision.judgeUsage !== undefined && (
          <>
            <dt>{t('drill.engine.usage')}</dt>
            <dd>{t('drill.engine.usageValue', { input: formatTokens(promptTokens(decision.judgeUsage)), output: formatTokens(decision.judgeUsage.outputTokens) })}</dd>
          </>
        )}
        {decision.engineFailure !== undefined && (
          <>
            <dt>{t('drill.engine.failure')}</dt>
            <dd>
              {decision.engineFailure.engineState === undefined
                ? decision.engineFailure.code
                : `${decision.engineFailure.code} · ${t('drill.engine.warmUp', { state: t(`drill.engine.state.${decision.engineFailure.engineState}`) })}`}
            </dd>
          </>
        )}
        <dt>{t('drill.engine.seq')}</dt><dd className={css.mono}>{detail.seq}</dd>
      </dl>

      {question !== undefined && (
        <>
          <h3 className={css.section}>{t('drill.question')}</h3>
          <blockquote className={css.question}>{question}</blockquote>
        </>
      )}

      {options.length > 0 && (
        <>
          <h3 className={css.section}>{t('drill.options')}</h3>
          <table className={css.table}>
            <thead><tr><th scope="col">{t('drill.col.option')}</th><th scope="col">{t('drill.col.route')}</th><th scope="col">{t('drill.col.probability')}</th></tr></thead>
            <tbody>
              {options.map(option => (
                <tr key={option.option} className={clsx(option.chosen && css.chosen)}>
                  <td>{option.chosen ? t('drill.chosen', { option: option.option }) : option.option}</td>
                  <td>
                    <span className={css.mono}>{option.route ?? t('drill.keepCurrent')}</span>
                    {option.description !== undefined && <span className={css.muted}>{option.description}</span>}
                  </td>
                  <td>
                    <span className={css.bar} aria-hidden="true"><span className={css.barFill} style={{ width: `${Math.round(option.probability * 100)}%` }} /></span>
                    {formatScore(option.probability)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h3 className={css.section}>{t('drill.gate')} <span className={css.warnPill}>{thresholdSourceLabel(thresholds, t)}</span></h3>
      <div className={css.scales}>
        <Scale
          label={t('drill.confidence')}
          value={confidence}
          threshold={thresholds.downgradeThreshold}
          thresholdLabel={thresholdLabel(thresholds.downgradeThreshold)}
          max={1}
          t={t}
        />
        <Scale
          label={t('drill.margin')}
          value={margin}
          threshold={thresholds.downgradeMargin}
          thresholdLabel={thresholdLabel(thresholds.downgradeMargin)}
          max={1}
          t={t}
        />
      </div>
      <Scale
        label={t('drill.difficulty', { max: levels })}
        value={decision.difficulty?.score}
        threshold={thresholds.entryScoreCeiling}
        second={thresholds.escalateBackScoreThreshold}
        thresholdLabel={t('drill.difficulty.enter', { value: thresholds.entryScoreCeiling })}
        secondLabel={t('drill.difficulty.exit', { value: thresholds.escalateBackScoreThreshold })}
        max={levels}
        t={t}
      />
      {thresholds.source === 'recorded' && thresholds.difficultySource === 'now' && <p className={css.muted}>{t('drill.difficulty.now')}</p>}

      <h3 className={css.section}>{t('drill.why')}</h3>
      <ol className={css.path}>
        {path.map(check => (
          <li key={check.id} className={clsx(css.check, check.first && css.checkFirst)} data-status={check.status}>
            <span className={css.checkStatus}>{t(`check.status.${check.status}`)}</span>
            {t(`check.${check.id}`)}
          </li>
        ))}
      </ol>

      {assessments.length > 0 && (
        <>
          <h3 className={css.section}>{t('drill.eligibility')}</h3>
          <table className={css.table}>
            <thead><tr><th scope="col">{t('drill.col.candidate')}</th><th scope="col">{t('drill.col.eligibility')}</th></tr></thead>
            <tbody>
              {assessments.map(assessment => (
                <tr key={assessment.id}><td className={css.mono}>{`${assessment.provider} / ${assessment.model}`}</td><td>{assessment.reason}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h3 className={css.section}>{t('drill.state')}</h3>
      <dl className={css.facts}>
        <dt>{t('drill.state.size')}</dt>
        <dd>{input !== undefined
          ? t('drill.state.exact', { chars: input.state.length, tokens: input.stateTokens })
          : decision.inputChars !== undefined
            ? t('drill.state.sent', { chars: decision.inputChars })
            : projection === undefined ? t('drill.none') : t('drill.state.atMost', { chars: projection.maxChars })}</dd>
        {heads.map(head => (
          <Fragment key={head.question}>
            <dt>{t('drill.state.head', { question: head.question })}</dt>
            <dd>{t('drill.state.headValue', { head: head.tokens, max: head.max })}</dd>
          </Fragment>
        ))}
        {decision.judgmentRejection !== undefined && (
          <>
            <dt>{t('drill.state.rejected')}</dt>
            <dd>{t('drill.state.rejectedValue', {
              reason: decision.judgmentRejection.reason,
              head: decision.judgmentRejection.limits.maxHeadTokens,
            })}</dd>
          </>
        )}
        {input !== undefined && decision.inputChars !== undefined && decision.inputChars !== input.state.length && (
          <><dt>{t('drill.state.offered')}</dt><dd>{t('drill.state.offeredValue', { chars: decision.inputChars })}</dd></>
        )}
        {projection !== undefined && (
          <>
            <dt>{t('drill.state.renderer')}</dt><dd className={css.mono}>{t('drill.state.rendererValue', { renderer: projection.renderer, turns: projection.contextTurns })}</dd>
            <dt>{t('drill.state.seqs')}</dt><dd className={css.mono}>{t('drill.state.seqsValue', { included: decision.stateSeqs.length, omitted: projection.omittedSeqs.length })}</dd>
          </>
        )}
      </dl>
      {input !== undefined && (showState
        ? <pre className={css.stateText}>{input.state}</pre>
        : <button type="button" className={css.button} onClick={onShowState}>{t('drill.state.show')}</button>)}

      <h3 className={css.section}>{t('drill.sticky')}</h3>
      <dl className={css.facts}>
        <dt>{t('drill.sticky.steps')}</dt><dd>{decision.sticky.stepsElapsed}</dd>
        {!decision.sticky.active && decision.sticky.brokenBy !== undefined && (<><dt>{t('drill.sticky.brokenBy')}</dt><dd>{decision.sticky.brokenBy}</dd></>)}
        {decision.sticky.entryBase !== undefined && (<><dt>{t('drill.sticky.entryBase')}</dt><dd className={css.mono}>{`${decision.sticky.entryBase.provider} / ${decision.sticky.entryBase.model}`}</dd></>)}
        {decision.objective !== undefined && (<><dt>{t('drill.sticky.objective')}</dt><dd>{decision.objective}</dd></>)}
      </dl>
    </>
  )
}

/** Props of one horizontal score scale. */
interface ScaleProps {
  label: string
  value: number | undefined
  threshold: number
  second?: number
  thresholdLabel: string
  secondLabel?: string
  max: number
  t: RoutingTranslate
}

/** One score on a 0-to-max scale with its threshold ticks. */
function Scale({ label, value, threshold, second, thresholdLabel, secondLabel, max, t }: ScaleProps) {
  const at = (score: number): string => `${Math.min(100, Math.max(0, (score / max) * 100))}%`
  return (
    <div className={css.scale}>
      <span className={css.scaleLabel}>{label}</span>
      <span className={css.scaleValue}>{value === undefined ? t('drill.none') : formatScore(value)}</span>
      <span className={css.scaleTrack} aria-hidden="true">
        {value !== undefined && <span className={css.scaleFill} style={{ width: at(value) }} />}
        <span className={css.scaleTick} style={{ left: at(threshold) }} />
        {second !== undefined && <span className={css.scaleTick} style={{ left: at(second) }} />}
      </span>
      <span className={css.scaleTicks}>
        {thresholdLabel}
        {secondLabel !== undefined && ` · ${secondLabel}`}
      </span>
    </div>
  )
}
