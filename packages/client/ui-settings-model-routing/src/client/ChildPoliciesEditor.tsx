/**
 * Subagent routing rules: gated on the host schema declaring childPolicies.
 * Pool-id select, judge toggle (disabled while uncalibrated), inline named errors.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { LAYA_ENGINE } from './model.ts'
import type { ModelRoutingController, ModelRoutingState, WriteFailure } from './model.ts'
import { childPoliciesSection, hasChildPoliciesCapability, poolSection, routerEngine } from './view.ts'
import type { ChildPolicyDraft, ChildPoliciesSection, Translate } from './view.ts'
import css from './ModelRoutingSection.module.css'

function rowFailure(failure: WriteFailure | undefined, index: number): WriteFailure | undefined {
  return failure?.path?.[0] === 'childPolicies' && failure.path[1] === index ? failure : undefined
}

export interface ChildPoliciesEditorProps {
  state: ModelRoutingState
  controller: ModelRoutingController
  t: Translate
}

export function ChildPoliciesEditor({ state, controller, t }: ChildPoliciesEditorProps): ReactNode {
  const [draft, setDraft] = useState<ChildPoliciesSection | null>(null)
  const [failure, setFailure] = useState<WriteFailure | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  if (state.router === null) return null
  if (!hasChildPoliciesCapability(state.router.schema)) return null
  const stored = childPoliciesSection(state.router)
  const rows = draft ?? stored
  const poolIds = poolSection(state.router).candidates.map(candidate => candidate.id).filter(id => id.length > 0)
  const engineId = routerEngine(state.engines)
  const calibrated = (engineId !== undefined && engineId !== LAYA_ENGINE) || state.laya?.state === 'ready'
  const disabled = busy || !state.writable
  const judges = rows.childPolicies.some(rule => rule.judge)

  const commit = (next: ChildPoliciesSection): void => {
    setDraft(next)
    setFailure(undefined)
    setBusy(true)
    const written = next.childPolicies.map(rule => ({
      match: {
        ...rule.matchKind === undefined ? {} : { kind: rule.matchKind },
        ...rule.agentType === undefined || rule.agentType.length === 0 ? {} : { agentType: rule.agentType },
      },
      candidate: rule.candidate,
      ...rule.judge ? { judge: true } : {},
    }))
    void controller.saveChildPolicies(written, next.childRouteErrors, next.childRouteInstructions).then((result) => {
      setBusy(false)
      setFailure(result)
      if (result === undefined) setDraft(null)
    })
  }

  const update = (index: number, patch: Partial<ChildPolicyDraft>): void => {
    commit({
      ...rows,
      childPolicies: rows.childPolicies.map((rule, at) => at === index ? { ...rule, ...patch } : rule),
    })
  }

  return (
    <section className={css['card']}>
      <div className={css['cardHead']}>
        <h2 className={css['cardTitle']}>{t('childTitle')}</h2>
      </div>
      <p className={css['muted']}>{t('childIntro')}</p>
      <p className={css['muted']}>{t('childFork')}</p>
      <p className={css['muted']}>{t('childOnce')}</p>
      {rows.childPolicies.map((rule, index) => {
        const error = rowFailure(failure, index)
        return (
          <div key={index} className={clsx(css['formRow'], css['policyRow'])}>
            <label className={clsx(css['fieldLabel'], css['policyField'])}>
              {t('childKind')}
              <select
                className={css['select']}
                disabled={disabled}
                value={rule.matchKind ?? ''}
                onChange={(event) => {
                  const value = event.target.value
                  commit({
                    ...rows,
                    childPolicies: rows.childPolicies.map((current, at) => {
                      if (at !== index) return current
                      if (value === 'subagent' || value === 'workflow') return { ...current, matchKind: value }
                      const { matchKind: _dropped, ...rest } = current
                      return rest
                    }),
                  })
                }}
              >
                <option value="">{t('childKindAny')}</option>
                <option value="subagent">{t('childKindSubagent')}</option>
                <option value="workflow">{t('childKindWorkflow')}</option>
              </select>
            </label>
            <label className={clsx(css['fieldLabel'], css['policyField'])}>
              {t('childAgentType')}
              <input
                className={css['input']}
                disabled={disabled}
                value={rule.agentType ?? ''}
                onChange={event => update(index, { agentType: event.target.value })}
              />
            </label>
            <label className={clsx(css['fieldLabel'], css['policyField'])}>
              {t('childCandidate')}
              <select
                className={css['select']}
                disabled={disabled}
                value={rule.candidate}
                onChange={event => update(index, { candidate: event.target.value })}
              >
                <option value="" />
                {poolIds.map(id => <option key={id} value={id}>{id}</option>)}
              </select>
            </label>
            <label className={clsx(css['fieldLabel'], css['policyCheck'])}>
              {t('childJudge')}
              <input
                type="checkbox"
                disabled={disabled || !calibrated}
                title={!calibrated ? t('childJudgeOff') : undefined}
                checked={rule.judge}
                onChange={event => update(index, { judge: event.target.checked })}
              />
            </label>
            <div className={clsx(css['formActions'], css['policyActions'])}>
              <button type="button" className={css['button']} disabled={disabled || index === 0} onClick={() => {
                const next = [...rows.childPolicies]
                const current = next[index]
                const previous = next[index - 1]
                if (current === undefined || previous === undefined) return
                next[index - 1] = current
                next[index] = previous
                commit({ ...rows, childPolicies: next })
              }}>{t('childUp', { index: index + 1 })}</button>
              <button type="button" className={css['button']} disabled={disabled || index === rows.childPolicies.length - 1} onClick={() => {
                const next = [...rows.childPolicies]
                const current = next[index]
                const following = next[index + 1]
                if (current === undefined || following === undefined) return
                next[index + 1] = current
                next[index] = following
                commit({ ...rows, childPolicies: next })
              }}>{t('childDown', { index: index + 1 })}</button>
              <button type="button" className={css['button']} disabled={disabled} onClick={() => {
                commit({ ...rows, childPolicies: rows.childPolicies.filter((_, at) => at !== index) })
              }}>{t('childDelete', { index: index + 1 })}</button>
            </div>
            {error !== undefined ? <p className={clsx(css['fieldError'], css['policyError'])} role="alert">{error.message}</p> : null}
          </div>
        )
      })}
      <div className={css['formActions']}>
        <button type="button" className={css['button']} disabled={disabled} onClick={() => {
          commit({ ...rows, childPolicies: [...rows.childPolicies, { candidate: poolIds[0] ?? '', judge: false }] })
        }}>{t('childAdd')}</button>
      </div>
      <label className={clsx(css['fieldLabel'], css['policyField'])}>
        {t('childErrors')}
        <input
          className={css['input']}
          type="number"
          min={1}
          disabled={disabled}
          value={rows.childRouteErrors}
          onChange={event => commit({ ...rows, childRouteErrors: Number(event.target.value) })}
        />
      </label>
      {judges
        ? (
          <label className={clsx(css['fieldLabel'], css['policyField'])}>
            {t('childInstructions')}
            <textarea
              className={css['textarea']}
              disabled={disabled}
              value={rows.childRouteInstructions ?? ''}
              onChange={event => commit({ ...rows, childRouteInstructions: event.target.value })}
            />
          </label>
        )
        : null}
      {failure !== undefined && failure.path?.[0] !== 'childPolicies'
        ? <p className={clsx(css['fieldError'])} role="alert">{failure.message}</p>
        : null}
      {busy ? <p className={css['muted']} role="status">{t('poolSaving')}</p> : null}
    </section>
  )
}
