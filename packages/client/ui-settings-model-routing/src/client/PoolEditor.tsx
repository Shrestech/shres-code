/**
 * The shared candidate pool and the Route from allowlist, edited together:
 * one settings write carries both lists, so a pool edit and a Route from edit
 * never race. Notes beside a pool model come from the router's pool status and
 * name capability and token facts only.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { ModelRoutingObjective, ModelRoutingPoolStatus } from '@shres-code/shres-code-model-router/client'
import { LAYA_ENGINE } from './model.ts'
import type { ModelRoutingController, ModelRoutingState, PoolCandidateDraft, RouteFromDraft, WriteFailure } from './model.ts'
import { catalogModels, modelLabel, poolIdFor, poolNotes, poolSection, routerEngine } from './view.ts'
import type { CatalogModel, PoolSection, Translate } from './view.ts'
import css from './ModelRoutingSection.module.css'

/** Longest description the router accepts, in characters: every description is sent in every judgment question. */
export const MAX_DESCRIPTION_CHARS = 160

/** Character count from which the counter warns that the hard limit is near. */
export const DESCRIPTION_GUIDANCE_CHARS = 120

const OBJECTIVES: readonly ModelRoutingObjective[] = ['quota', 'dollars', 'latency']

/** Copy keys of each objective. */
const OBJECTIVE_COPY = {
  quota: { label: 'objectiveQuota', title: 'objectiveQuotaTitle' },
  dollars: { label: 'objectiveDollars', title: 'objectiveDollarsTitle' },
  latency: { label: 'objectiveLatency', title: 'objectiveLatencyTitle' },
} as const

/**
 * Whether a Route from entry is complete enough to write: it names an
 * objective. Every-turn entry is a separate opt-in allowance on a quota
 * route, not a precondition, so a quota entry without it writes and the
 * router's own validation has the final word.
 * @param entry - the entry.
 * @returns whether it can be written.
 */
export function routeFromComplete(entry: RouteFromDraft): boolean {
  return entry.objective !== undefined
}

/**
 * The failure a row shows: one whose path names that list and index.
 * @param failure - the last rejected write.
 * @param list - `candidates` or `routeFrom`.
 * @param index - the row.
 * @returns the failure, or undefined.
 */
function rowFailure(failure: WriteFailure | undefined, list: 'candidates' | 'routeFrom', index: number): WriteFailure | undefined {
  return failure?.path?.[0] === list && failure.path[1] === index ? failure : undefined
}

/**
 * The failure a card shows: one naming its list but no row, or, for the pool
 * card, one naming no list of this editor at all.
 */
function cardFailure(failure: WriteFailure | undefined, list: 'candidates' | 'routeFrom'): WriteFailure | undefined {
  if (failure === undefined) return undefined
  const [head, index] = failure.path ?? []
  if (head === list) return typeof index === 'number' ? undefined : failure
  return list === 'candidates' && head !== 'routeFrom' ? failure : undefined
}

/** Props of {@link PoolEditor}. */
export interface PoolEditorProps {
  state: ModelRoutingState
  controller: ModelRoutingController
  t: Translate
}

/** The Candidate pool and Route from cards; renders nothing without the `model-router` section. */
export function PoolEditor({ state, controller, t }: PoolEditorProps): ReactNode {
  const [draft, setDraft] = useState<PoolSection | null>(null)
  const [failure, setFailure] = useState<WriteFailure | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  if (state.router === null) return null
  const stored = poolSection(state.router)
  const rows = draft ?? stored
  const catalog = catalogModels(state.models ?? [])
  const disabled = busy || !state.writable
  // The judge hint names the token budget only while the routed engine is the
  // local Laya gateway and its view reports the checkpoint context.
  const layaTokens = routerEngine(state.engines) === LAYA_ENGINE ? state.laya?.checkpointContext : undefined
  const hint = layaTokens === undefined
    ? t('poolDescriptionHint')
    : t('poolDescriptionHintLaya', { tokens: layaTokens.toLocaleString('en-US') })

  /** Adopt an edit: write it when every Route from entry is complete, else hold it in the draft. */
  const commit = (next: PoolSection): void => {
    setDraft(next)
    setFailure(undefined)
    if (!next.routeFrom.every(routeFromComplete)) return
    setBusy(true)
    void controller.savePool(next.candidates, next.routeFrom).then((result) => {
      setBusy(false)
      setFailure(result)
      if (result === undefined) setDraft(null)
    })
  }
  const discard = (): void => {
    setDraft(null)
    setFailure(undefined)
  }
  const unsaved = draft !== null && !busy

  return (
    <>
      <PoolCard
        rows={rows}
        draft={draft !== null}
        pool={state.pool}
        catalog={catalog}
        disabled={disabled}
        failure={failure}
        commit={commit}
        hint={hint}
        t={t}
      />
      <RouteFromCard rows={rows} catalog={catalog} disabled={disabled} failure={failure} commit={commit} t={t} />
      {unsaved
        ? (
          <div className={css['unsaved']} role="status">
            <span>{t('poolUnsaved')}</span>
            {rows.routeFrom.every(routeFromComplete)
              ? <button type="button" className={css['button']} onClick={() => { commit(rows) }}>{t('poolRetry')}</button>
              : null}
            <button type="button" className={css['button']} onClick={discard}>{t('poolDiscard')}</button>
          </div>
        )
        : null}
      {busy ? <p className={css['muted']} role="status">{t('poolSaving')}</p> : null}
    </>
  )
}

/** Props of {@link PoolCard}. */
interface PoolCardProps {
  rows: PoolSection
  draft: boolean
  pool: ModelRoutingPoolStatus | null
  catalog: readonly CatalogModel[]
  disabled: boolean
  failure: WriteFailure | undefined
  commit: (next: PoolSection) => void
  /** The description-editor hint, naming the judge's token budget when known. */
  hint: string
  t: Translate
}

/** The shared candidate pool. */
function PoolCard({ rows, draft, pool, catalog, disabled, failure, commit, hint, t }: PoolCardProps): ReactNode {
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<number | null>(null)
  const listFailure = cardFailure(failure, 'candidates')
  const replace = (index: number, entry: PoolCandidateDraft | undefined): void => {
    const candidates = entry === undefined
      ? rows.candidates.filter((_, at) => at !== index)
      : rows.candidates.map((current, at) => at === index ? entry : current)
    setEditing(null)
    commit({ ...rows, candidates })
  }
  return (
    <section className={css['card']} aria-label={t('poolTitle')}>
      <div className={css['cardHead']}>
        <div>
          <h3 className={css['cardTitle']}>{t('poolTitle')}</h3>
          <p className={css['sub']}>{t('poolIntro')}</p>
        </div>
        <button type="button" className={css['button']} disabled={disabled || adding} onClick={() => { setAdding(true) }}>
          {t('poolAdd')}
        </button>
      </div>
      {rows.candidates.length === 0 && !adding ? <p className={css['notice']}>{t('poolEmpty')}</p> : null}
      {rows.candidates.length === 0
        ? null
        : (
          <table className={css['table']}>
            <thead>
              <tr>
                <th scope="col">{t('poolModel')}</th>
                <th scope="col">{t('poolRoute')}</th>
                <th scope="col">{t('poolDescription')}</th>
                <th scope="col">{t('poolNotes')}</th>
                <th scope="col"><span className={css['hiddenLabel']}>{t('poolEdit')}</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.candidates.map((candidate, index) => {
                const label = modelLabel(catalog, candidate.provider, candidate.model)
                const status = draft ? undefined : pool?.candidates.find(entry => entry.id === candidate.id)
                const notes = status === undefined || pool === null ? [] : poolNotes(status, pool, catalog, t)
                const rowError = rowFailure(failure, 'candidates', index)
                return (
                  <tr key={`${String(index)}:${candidate.id}`} aria-invalid={rowError === undefined ? undefined : true}>
                    <th scope="row" className={css['modelName']}>{label}</th>
                    <td><code className={css['route']}>{candidate.provider}/{candidate.model}</code></td>
                    <td>
                      {editing === index
                        ? (
                          <CandidateForm
                            initial={candidate}
                            efforts={catalog.find(entry => entry.provider === candidate.provider
                              && entry.model === candidate.model)?.efforts}
                            title={t('poolEditTitle', { model: label })}
                            confirm={t('poolSave')}
                            disabled={disabled}
                            hint={hint}
                            onSubmit={(entry) => { replace(index, entry) }}
                            onCancel={() => { setEditing(null) }}
                            onRemove={() => { replace(index, undefined) }}
                            t={t}
                          />
                        )
                        : (
                          <span>
                            {candidate.description}
                            {' '}
                            <span className={css['counter']}>
                              {t('poolDescriptionCount', { count: candidate.description.length, max: MAX_DESCRIPTION_CHARS })}
                            </span>
                          </span>
                        )}
                      {rowError === undefined ? null : <p className={css['fieldError']} role="alert">{rowError.message}</p>}
                    </td>
                    <td>
                      <span className={css['notes']}>
                        {notes.map(note => (
                          <span key={note.text} className={clsx(css['pill'], css[note.tone])} title={note.title}>
                            {note.tone === 'neutral' ? null : <span className={css['dot']} aria-hidden="true" />}
                            {note.text}
                          </span>
                        ))}
                      </span>
                    </td>
                    <td>
                      {editing === index
                        ? null
                        : (
                          <button
                            type="button"
                            className={css['linkButton']}
                            disabled={disabled}
                            aria-label={t('poolEditTitle', { model: label })}
                            onClick={() => { setEditing(index) }}
                          >
                            {t('poolEdit')}
                          </button>
                        )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      {adding
        ? (
          <AddCandidate
            catalog={catalog}
            taken={new Set(rows.candidates.map(candidate => candidate.id))}
            disabled={disabled}
            hint={hint}
            onAdd={(entry) => {
              setAdding(false)
              commit({ ...rows, candidates: [...rows.candidates, entry] })
            }}
            onCancel={() => { setAdding(false) }}
            t={t}
          />
        )
        : null}
      {listFailure === undefined ? null : <p className={css['fieldError']} role="alert">{listFailure.message}</p>}
    </section>
  )
}

/** Props of {@link CandidateForm}. */
interface CandidateFormProps {
  initial: PoolCandidateDraft
  efforts: readonly string[] | undefined
  title: string
  confirm: string
  disabled: boolean
  onSubmit: (entry: PoolCandidateDraft) => void
  onCancel: () => void
  onRemove?: () => void
  hint: string
  t: Translate
}

/** Id, description, and effort of one pool model; the id arrives auto-slugged and stays editable. */
function CandidateForm(
  { initial, efforts, title, confirm, disabled, onSubmit, onCancel, onRemove, hint, t }: CandidateFormProps,
): ReactNode {
  const [id, setId] = useState(initial.id)
  const [description, setDescription] = useState(initial.description)
  const [effort, setEffort] = useState(initial.reasoningEffort ?? '')
  const { id: _initialId, reasoningEffort: _effort, ...identity } = initial
  return (
    <form
      className={css['form']}
      aria-label={title}
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit({ ...identity, id: id.trim(), description, ...effort === '' ? {} : { reasoningEffort: effort } })
      }}
    >
      <label className={css['fieldLabel']} title={t('poolIdTitle')}>
        {t('poolId')}
        <input className={css['input']} value={id} onChange={(event) => { setId(event.target.value) }} />
      </label>
      <label className={css['fieldLabel']}>
        {t('poolDescriptionLabel')}
        <textarea
          className={css['textarea']}
          value={description}
          maxLength={MAX_DESCRIPTION_CHARS}
          rows={2}
          onChange={(event) => { setDescription(event.target.value) }}
        />
      </label>
      <span
        className={clsx(css['counter'], description.length >= DESCRIPTION_GUIDANCE_CHARS && css['counterWarn'])}
        title={t('poolDescriptionLong', { max: MAX_DESCRIPTION_CHARS })}
      >
        {t('poolDescriptionCount', { count: description.length, max: MAX_DESCRIPTION_CHARS })}
      </span>
      <p className={css['detail']}>{hint}</p>
      {efforts === undefined
        ? null
        : (
          <label className={css['fieldLabel']}>
            {t('poolEffort')}
            <select className={css['select']} value={effort} onChange={(event) => { setEffort(event.target.value) }}>
              <option value="">{t('poolEffortDefault')}</option>
              {efforts.map(id => <option key={id} value={id}>{id}</option>)}
            </select>
          </label>
        )}
      <div className={css['formActions']}>
        <button type="submit" className={clsx(css['button'], css['primary'])} disabled={disabled || id.trim() === '' || description.trim() === ''}>{confirm}</button>
        <button type="button" className={css['button']} onClick={onCancel}>{t('poolCancel')}</button>
        {onRemove === undefined
          ? null
          : <button type="button" className={css['button']} disabled={disabled} onClick={onRemove}>{t('poolRemove')}</button>}
      </div>
    </form>
  )
}

/** Value of the picker's free-entry option. */
const OTHER = '__other__'

/** Props of {@link AddCandidate}. */
interface AddCandidateProps {
  catalog: readonly CatalogModel[]
  taken: ReadonlySet<string>
  disabled: boolean
  onAdd: (entry: PoolCandidateDraft) => void
  onCancel: () => void
  hint: string
  t: Translate
}

/** Pick a catalog model, or name a route and model, then describe it. */
function AddCandidate({ catalog, taken, disabled, onAdd, onCancel, hint, t }: AddCandidateProps): ReactNode {
  const [picked, setPicked] = useState('')
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const chosen = picked === OTHER ? undefined : catalog.find(entry => `${entry.provider}/${entry.model}` === picked)
  const route = chosen === undefined
    ? { provider: provider.trim(), model: model.trim() }
    : { provider: chosen.provider, model: chosen.model }
  const providers = [...new Map(catalog.map(entry => [entry.provider, entry.providerName])).entries()]
  return (
    <div className={css['addPanel']}>
      <label className={css['fieldLabel']}>
        {t('poolPick')}
        <select className={css['select']} value={picked} onChange={(event) => { setPicked(event.target.value) }}>
          <option value="" disabled>{t('poolPickPlaceholder')}</option>
          {providers.map(([id, name]) => (
            <optgroup key={id} label={name}>
              {catalog.filter(entry => entry.provider === id).map(entry => (
                <option key={entry.model} value={`${entry.provider}/${entry.model}`}>{entry.name}</option>
              ))}
            </optgroup>
          ))}
          <option value={OTHER}>{t('poolOther')}</option>
        </select>
      </label>
      {picked === OTHER
        ? (
          <div className={css['formRow']}>
            <label className={css['fieldLabel']}>
              {t('poolProvider')}
              <input className={css['input']} value={provider} onChange={(event) => { setProvider(event.target.value) }} />
            </label>
            <label className={css['fieldLabel']}>
              {t('poolModelId')}
              <input className={css['input']} value={model} onChange={(event) => { setModel(event.target.value) }} />
            </label>
          </div>
        )
        : null}
      {picked === '' || route.provider === '' || route.model === ''
        ? <div className={css['formActions']}><button type="button" className={css['button']} onClick={onCancel}>{t('poolCancel')}</button></div>
        : (
          <CandidateForm
            key={`${route.provider}/${route.model}`}
            initial={{ id: poolIdFor(route.model, taken), ...route, description: '' }}
            efforts={chosen?.efforts}
            title={t('poolAddTitle')}
            confirm={t('poolAddConfirm')}
            disabled={disabled}
            hint={hint}
            onSubmit={onAdd}
            onCancel={onCancel}
            t={t}
          />
        )}
    </div>
  )
}

/** Props of {@link RouteFromCard}. */
interface RouteFromCardProps {
  rows: PoolSection
  catalog: readonly CatalogModel[]
  disabled: boolean
  failure: WriteFailure | undefined
  commit: (next: PoolSection) => void
  t: Translate
}

/** The Route from allowlist: each enabled strong model with its objective. */
function RouteFromCard({ rows, catalog, disabled, failure, commit, t }: RouteFromCardProps): ReactNode {
  const listFailure = cardFailure(failure, 'routeFrom')
  const update = (index: number, entry: RouteFromDraft | undefined): void => {
    const routeFrom = entry === undefined
      ? rows.routeFrom.filter((_, at) => at !== index)
      : rows.routeFrom.map((current, at) => at === index ? entry : current)
    commit({ ...rows, routeFrom })
  }
  const offered = catalog.filter(entry => !rows.routeFrom.some(row => row.provider === entry.provider && row.model === entry.model))
  return (
    <section className={css['card']} aria-label={t('routeFromTitle')}>
      <h3 className={css['cardTitle']}>{t('routeFromTitle')}</h3>
      <p className={css['sub']}>{t('routeFromIntro')}</p>
      {rows.routeFrom.length === 0 ? <p className={css['notice']}>{t('routeFromEmpty')}</p> : null}
      {rows.routeFrom.length === 0
        ? null
        : (
          <table className={css['table']}>
            <thead>
              <tr>
                <th scope="col">{t('routeFromModel')}</th>
                <th scope="col">{t('poolRoute')}</th>
                <th scope="col">{t('routeFromEnabled')}</th>
                <th scope="col">{t('routeFromObjective')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.routeFrom.map((entry, index) => {
                const label = modelLabel(catalog, entry.provider, entry.model)
                const rowError = rowFailure(failure, 'routeFrom', index)
                return (
                  <tr key={`${String(index)}:${entry.provider}/${entry.model}`} aria-invalid={rowError === undefined ? undefined : true}>
                    <th scope="row" className={css['modelName']}>{label}</th>
                    <td><code className={css['route']}>{entry.provider}/{entry.model}</code></td>
                    <td>
                      <button
                        type="button"
                        role="switch"
                        aria-checked="true"
                        aria-label={t('routeFromDisable', { model: label })}
                        className={clsx(css['pill'], css['ok'])}
                        disabled={disabled}
                        onClick={() => { update(index, undefined) }}
                      >
                        <span className={css['dot']} aria-hidden="true" />
                        {t('routeFromOn')}
                      </button>
                    </td>
                    <td>
                      <div className={css['objectiveRow']}>
                        <div className={css['segmented']} role="radiogroup" aria-label={t('objectiveGroup', { model: label })}>
                          {OBJECTIVES.map(objective => (
                            <button
                              key={objective}
                              type="button"
                              role="radio"
                              aria-checked={entry.objective === objective}
                              title={t(OBJECTIVE_COPY[objective].title)}
                              className={clsx(css['segment'], entry.objective === objective && css['segmentOn'])}
                              disabled={disabled}
                              onClick={() => {
                                if (entry.objective !== objective) update(index, { ...entry, objective })
                              }}
                            >
                              {t(OBJECTIVE_COPY[objective].label)}
                            </button>
                          ))}
                        </div>
                        {entry.objective === 'quota'
                          ? (
                            <button
                              type="button"
                              role="switch"
                              aria-checked={entry.allowEveryTurn === true}
                              aria-label={t('everyTurnAllow', { model: label })}
                              className={clsx(css['pill'], entry.allowEveryTurn === true && css['ok'])}
                              disabled={disabled}
                              onClick={() => {
                                const { allowEveryTurn: _allowance, ...rest } = entry
                                update(index, entry.allowEveryTurn !== true ? { ...rest, allowEveryTurn: true } : rest)
                              }}
                            >
                              {t(entry.allowEveryTurn === true ? 'everyTurnAllowed' : 'everyTurn')}
                            </button>
                          )
                          : null}
                      </div>
                      {entry.objective === undefined ? <p className={css['detail']}>{t('objectiveNeeded')}</p> : null}
                      {rowError === undefined ? null : <p className={css['fieldError']} role="alert">{rowError.message}</p>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      <label className={css['fieldLabel']}>
        {t('routeFromPick')}
        <select
          className={css['select']}
          value=""
          disabled={disabled || offered.length === 0}
          onChange={(event) => {
            const pick = offered.find(entry => `${entry.provider}/${entry.model}` === event.target.value)
            if (pick !== undefined) commit({ ...rows, routeFrom: [...rows.routeFrom, { provider: pick.provider, model: pick.model }] })
          }}
        >
          <option value="" disabled>{t('routeFromAdd')}</option>
          {offered.map(entry => (
            <option key={`${entry.provider}/${entry.model}`} value={`${entry.provider}/${entry.model}`}>
              {entry.providerName} · {entry.name}
            </option>
          ))}
        </select>
      </label>
      {listFailure === undefined ? null : <p className={css['fieldError']} role="alert">{listFailure.message}</p>}
    </section>
  )
}
