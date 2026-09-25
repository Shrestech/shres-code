/**
 * The Judgment engine card: the deployment-wide engine selector with each
 * engine's live state, the selected engine's egress, model ids, and
 * calibration badge, the egress notice, and the local Laya gateway row.
 */

import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import type { JudgmentEngineView, LayaGatewayState } from '@shres-code/shres-code-api-remotes/client'
import clsx from 'clsx'
import type { ModelRoutingController, ModelRoutingState, WriteFailure } from './model.ts'
import { LAYA_ENGINE } from './model.ts'
import { calibratedBy, engineOption, isRemote, lastExitText, modelsText, numberAt, stateLabel } from './view.ts'
import type { Translate } from './view.ts'
import css from './ModelRoutingSection.module.css'

/** Props of {@link EngineCard}. */
export interface EngineCardProps {
  state: ModelRoutingState
  controller: ModelRoutingController
  t: Translate
}

/** A state pill: a dot in the state's tone and its label, with the detail as its title. */
function StatePill({ state, detail, t }: { state: JudgmentEngineView['state'] | LayaGatewayState; detail?: string; t: Translate }): ReactNode {
  const { label, tone } = stateLabel(state, t)
  return (
    <span className={clsx(css['pill'], css[tone])} title={detail}>
      <span className={css['dot']} aria-hidden="true" />
      {label}
    </span>
  )
}

/** Render the engine card; it needs the engine view. */
export function EngineCard({ state, controller, t }: EngineCardProps): ReactNode {
  const selectId = useId()
  const errorId = useId()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<WriteFailure | undefined>(undefined)
  const engines = state.engines
  if (engines === null) return null

  const selectedId = engines.selection.engine
  const selected = engines.engines.find(engine => engine.id === selectedId)
  const evaluatedBy = selected === undefined ? undefined : calibratedBy(state.router, selected.id)
  const choose = (id: string): void => {
    setBusy(true)
    setFailure(undefined)
    void controller.selectEngine(id).then((result) => {
      setBusy(false)
      setFailure(result)
    })
  }

  return (
    <section className={css['card']} aria-labelledby={`${selectId}-title`}>
      <h3 id={`${selectId}-title`} className={css['cardTitle']}>{t('engineTitle')}</h3>
      <p className={css['sub']}>{t('engineIntro')}</p>
      {engines.engines.length === 0
        ? <p className={css['notice']} role="status">{t('noEngines')}</p>
        : (
          <div className={css['engineRow']}>
            <label className={css['fieldLabel']} htmlFor={selectId}>{t('engineLabel')}</label>
            <div className={css['engineControls']}>
              <select
                id={selectId}
                className={css['select']}
                value={selectedId}
                disabled={busy || !state.writable}
                aria-invalid={failure === undefined ? undefined : true}
                aria-describedby={failure === undefined ? undefined : errorId}
                onChange={(event) => { choose(event.target.value) }}
              >
                {selected === undefined ? <option value={selectedId} disabled>{selectedId}</option> : null}
                {engines.engines.map(engine => (
                  <option key={engine.id} value={engine.id} disabled={!engine.runsOnThisHost}>
                    {engineOption(engine, t)}
                  </option>
                ))}
              </select>
              {selected === undefined ? null : <EngineFacts engine={selected} evaluatedBy={evaluatedBy} t={t} />}
              {busy ? <span className={css['muted']} role="status">{t('engineSaving')}</span> : null}
            </div>
            {failure === undefined
              ? null
              : (
                <p id={errorId} className={css['fieldError']} role="alert">
                  {failure.path === undefined ? failure.message : t('engineRejected', { field: failure.path.join('.'), message: failure.message })}
                </p>
              )}
          </div>
        )}
      {engines.engines.length > 0 && selected === undefined
        ? <p className={css['warning']} role="status">{t('selectedMissing', { engine: selectedId })}</p>
        : null}
      {selected !== undefined && selected.state !== 'ready' && selected.detail !== undefined
        ? <p className={css['detail']}>{selected.detail}</p>
        : null}
      {selected === undefined ? null : <EgressNotice engine={selected} state={state} t={t} />}
      {engines.engines.some(engine => engine.id === LAYA_ENGINE) ? <LayaRow state={state} controller={controller} t={t} /> : null}
    </section>
  )
}

/** The selected engine's state, egress, model ids, and whether its routing thresholds were evaluated. */
function EngineFacts({ engine, evaluatedBy, t }: { engine: JudgmentEngineView; evaluatedBy: string | undefined; t: Translate }): ReactNode {
  const remote = isRemote(engine)
  const models = modelsText(engine, t)
  return (
    <span className={css['facts']}>
      <StatePill state={engine.state} {...engine.detail === undefined ? {} : { detail: engine.detail }} t={t} />
      <span className={clsx(css['pill'], remote ? css['warn'] : css['local'])} title={t(remote ? 'egressRemoteTitle' : 'egressLocalTitle')}>
        <span className={css['dot']} aria-hidden="true" />
        {t(remote ? 'egressRemote' : 'egressLocal')}
      </span>
      {models === undefined ? null : <code className={css['modelId']}>{models}</code>}
      {evaluatedBy === undefined
        ? <span className={css['uncalibrated']} title={t('uncalibratedTitle')}>{t('uncalibrated')}</span>
        : <span className={css['pill']} title={t('calibratedTitle', { by: evaluatedBy })}>{t('calibrated')}</span>}
    </span>
  )
}

/** The egress notice: a warning for a remote engine, a plain note otherwise. */
function EgressNotice({ engine, state, t }: { engine: JudgmentEngineView; state: ModelRoutingState; t: Translate }): ReactNode {
  if (!isRemote(engine)) return <p className={css['egressNote']}>{t('localNote')}</p>
  const chars = numberAt(state.router, ['state', 'maxChars'])
  const destination = engine.destination ?? t('remoteWarningDestination')
  return (
    <p className={css['warning']} role="note">
      <strong>{t('remoteWarningLead')}</strong>
      {' '}
      {chars === undefined
        ? t('remoteWarningBodyUnbounded', { destination })
        : t('remoteWarningBody', { chars: chars.toLocaleString('en-US'), destination })}
      {' '}
      {t('remoteWarningTail')}
    </p>
  )
}

/** The local Laya gateway row: state, pinned artifact, context size, and actions. */
function LayaRow({ state, controller, t }: EngineCardProps): ReactNode {
  const [confirming, setConfirming] = useState(false)
  const laya = state.laya
  const acting = state.layaAction !== null || laya?.installing === true
  const run = (action: 'install' | 'restart'): void => {
    setConfirming(false)
    void controller.runLaya(action)
  }
  const exit = laya === null ? undefined : lastExitText(laya, t)
  return (
    <div className={css['laya']} aria-label={t('layaName')} role="group">
      <div className={css['layaFacts']}>
        <strong>{t('layaName')}</strong>
        {laya === null
          ? null
          : (
            <>
              <StatePill state={laya.state} {...laya.detail === undefined ? {} : { detail: laya.detail }} t={t} />
              <code className={css['modelId']}>{laya.modelId}</code>
              <span>{t('layaContext', { tokens: laya.checkpointContext.toLocaleString('en-US') })}</span>
              <span>{t('layaRuntime')}</span>
            </>
          )}
      </div>
      {laya === null
        ? null
        : (
          <div className={css['layaActions']}>
            {state.layaAction === 'install' || laya.installing
              ? <span className={css['muted']} role="status">{t('layaInstalling')}</span>
              : null}
            {state.layaAction === 'restart' ? <span className={css['muted']} role="status">{t('layaRestarting')}</span> : null}
            {laya.state === 'not-installed'
              ? <button type="button" className={css['button']} disabled={acting} onClick={() => { run('install') }}>{t('layaInstall')}</button>
              : (
                <>
                  <button type="button" className={css['button']} disabled={acting} onClick={() => { run('restart') }}>{t('layaRestart')}</button>
                  <button type="button" className={css['button']} disabled={acting} onClick={() => { setConfirming(true) }}>{t('layaReinstall')}</button>
                </>
              )}
          </div>
        )}
      {laya !== null && laya.state !== 'ready' && laya.detail !== undefined ? <p className={css['detail']}>{laya.detail}</p> : null}
      {exit === undefined ? null : <p className={css['detail']}>{exit}</p>}
      {state.layaError === null ? null : <p className={css['fieldError']} role="alert">{t('layaFailed', { message: state.layaError })}</p>}
      {confirming
        ? (
          <div className={css['confirm']} role="alertdialog" aria-label={t('layaReinstall')}>
            <p>{t('layaConfirm')}</p>
            <div className={css['confirmActions']}>
              <button type="button" className={css['button']} onClick={() => { setConfirming(false) }}>{t('layaCancel')}</button>
              <button type="button" className={clsx(css['button'], css['primary'])} onClick={() => { run('install') }}>{t('layaConfirmAction')}</button>
            </div>
          </div>
        )
        : null}
    </div>
  )
}
