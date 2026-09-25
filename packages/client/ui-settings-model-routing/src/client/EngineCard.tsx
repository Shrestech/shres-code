/**
 * The Judgment engine card: the deployment-wide engine selector with each
 * engine's live state, the selected engine's egress and model ids, the engine
 * each declared consumer asks (with the router's gate for its engine), the
 * egress notice over those consumers, and the local Laya gateway row.
 */

import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import type { JudgmentEnginesSnapshot, JudgmentEngineView, LayaGatewayState } from '@shres-code/shres-code-api-remotes/client'
import clsx from 'clsx'
import type { ModelRoutingController, ModelRoutingState, WriteFailure } from './model.ts'
import { LAYA_ENGINE, ROUTER_CONSUMER } from './model.ts'
import {
  consumerRoutes, engineOption, ignoredOverrides, isRemote, lastExitText, modelsText, numberAt, routingCalibration, stateLabel,
} from './view.ts'
import type { ConsumerRoute, Translate } from './view.ts'
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
              {selected === undefined ? null : <EngineFacts engine={selected} t={t} />}
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
      <ConsumerList snapshot={engines} state={state} t={t} />
      <EgressNotice snapshot={engines} state={state} t={t} />
      {engines.engines.some(engine => engine.id === LAYA_ENGINE) ? <LayaRow state={state} controller={controller} t={t} /> : null}
    </section>
  )
}

/** An engine's egress badge. */
function EgressPill({ engine, t }: { engine: JudgmentEngineView; t: Translate }): ReactNode {
  const remote = isRemote(engine)
  return (
    <span className={clsx(css['pill'], remote ? css['warn'] : css['local'])} title={t(remote ? 'egressRemoteTitle' : 'egressLocalTitle')}>
      <span className={css['dot']} aria-hidden="true" />
      {t(remote ? 'egressRemote' : 'egressLocal')}
    </span>
  )
}

/** The selected engine's state, egress, and model ids. */
function EngineFacts({ engine, t }: { engine: JudgmentEngineView; t: Translate }): ReactNode {
  const models = modelsText(engine, t)
  return (
    <span className={css['facts']}>
      <StatePill state={engine.state} {...engine.detail === undefined ? {} : { detail: engine.detail }} t={t} />
      <EgressPill engine={engine} t={t} />
      {models === undefined ? null : <code className={css['modelId']}>{models}</code>}
    </span>
  )
}

/** How the router gates the engine it asks, from its operating points. */
function RoutingBadge({ engine, state, t }: { engine: JudgmentEngineView; state: ModelRoutingState; t: Translate }): ReactNode {
  const gate = routingCalibration(state.router, engine)
  switch (gate.kind) {
    case 'calibrated':
      return <span className={css['pill']} title={t('calibratedTitle', { by: gate.by })}>{t('calibrated', { by: gate.by })}</span>
    case 'point':
      return <span className={css['uncalibrated']} title={t('uncalibratedPointTitle')}>{t('uncalibratedPoint')}</span>
    case 'global':
      return <span className={css['uncalibrated']} title={t('uncalibratedGlobalTitle')}>{t('uncalibratedGlobal')}</span>
    case 'refused':
      return <span className={css['uncalibrated']} title={t('routingRefusedTitle')}>{t('routingRefused')}</span>
  }
}

/**
 * The engine each declared consumer asks: its engine and egress, whether an
 * override names it, and, for the router, how the router gates that engine;
 * then every override the dispatcher ignores.
 */
function ConsumerList({ snapshot, state, t }: { snapshot: JudgmentEnginesSnapshot; state: ModelRoutingState; t: Translate }): ReactNode {
  const routes = consumerRoutes(snapshot)
  const ignored = ignoredOverrides(snapshot)
  if (routes.length === 0 && ignored.length === 0) return null
  return (
    <div className={css['consumers']}>
      <span className={css['fieldLabel']}>{t('consumersTitle')}</span>
      {routes.length === 0
        ? null
        : (
          <ul className={css['consumerList']} aria-label={t('consumersGroup')}>
            {routes.map(route => (
              <li key={route.consumer} className={css['consumerRow']}>
                <code className={css['consumerId']}>{route.consumer}</code>
                {route.engine === undefined
                  ? <span className={css['detail']}>{t('consumerMissing', { engine: route.engineId })}</span>
                  : (
                    <>
                      <span>{route.engine.label}</span>
                      <EgressPill engine={route.engine} t={t} />
                      {route.consumer === ROUTER_CONSUMER && state.router !== null
                        ? <RoutingBadge engine={route.engine} state={state} t={t} />
                        : null}
                    </>
                  )}
                {route.overridden
                  ? <span className={css['pill']} title={t('consumerOverrideTitle')}>{t('consumerOverride')}</span>
                  : <span className={css['muted']}>{t('consumerSelected')}</span>}
              </li>
            ))}
          </ul>
        )}
      {ignored.map(({ consumer, engineId }) => (
        <p key={consumer} className={css['detail']}>{t('overrideIgnored', { consumer, engine: engineId })}</p>
      ))}
    </div>
  )
}

/** What one remote consumer sends: the router's state bound, or every ask of another consumer. */
function remoteScope(route: ConsumerRoute & { engine: JudgmentEngineView }, state: ModelRoutingState, t: Translate): string {
  if (route.consumer !== ROUTER_CONSUMER) return t('remoteConsumerAlways')
  const chars = numberAt(state.router, ['state', 'maxChars'])
  if (chars === undefined) return t('remoteRouterUnbounded')
  const count = numberAt(state.router, ['state', 'maxFitCandidates'])
  return route.engine.supportsFitting && count !== undefined
    ? t('remoteRouterBoundFitted', { count, chars: chars.toLocaleString('en-US') })
    : t('remoteRouterBound', { chars: chars.toLocaleString('en-US') })
}

/**
 * The egress notice over the declared consumers: a warning naming every
 * consumer whose engine is remote, with its engine, destination, and what it
 * sends; otherwise a note saying why nothing leaves this machine.
 */
function EgressNotice({ snapshot, state, t }: { snapshot: JudgmentEnginesSnapshot; state: ModelRoutingState; t: Translate }): ReactNode {
  if (!snapshot.selection.enabled) return <p className={css['egressNote']}>{t('egressOff')}</p>
  const routes = consumerRoutes(snapshot)
  if (routes.length === 0) return <p className={css['egressNote']}>{t('egressNoConsumers')}</p>
  const remote = routes.filter((route): route is ConsumerRoute & { engine: JudgmentEngineView } =>
    route.engine !== undefined && isRemote(route.engine))
  if (remote.length === 0) return <p className={css['egressNote']}>{t('localNote')}</p>
  return (
    <div className={css['warning']} role="note">
      <p className={css['warningText']}>
        <strong>{t('remoteWarningLead')}</strong>
        {' '}
        {t('remoteWarningIntro')}
      </p>
      <ul className={css['warningList']}>
        {remote.map(route => (
          <li key={route.consumer}>
            <code>{route.consumer}</code>
            {' '}
            {t('remoteConsumerTarget', { engine: route.engine.label, destination: route.engine.destination ?? t('remoteWarningDestination') })}
            {' '}
            {remoteScope(route, state, t)}
          </li>
        ))}
      </ul>
      {remote.some(route => route.consumer === ROUTER_CONSUMER) ? <p className={css['warningText']}>{t('remoteWarningTail')}</p> : null}
    </div>
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
