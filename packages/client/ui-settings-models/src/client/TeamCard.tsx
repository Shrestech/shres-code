/**
 * Models-page card for the default Team: the three named seats with editable
 * personas and model bindings, the generic Subagent hire, and user-added custom
 * members. Everything writes to the `agent-seats` settings namespace.
 */

import { useEffect, useState, type ReactNode } from 'react'
import type { IApiClient, ModelProviderGroup } from '@shres-code/shres-code-api-remotes/client'
import { FishLogo } from '@shres-code/shres-code-client-ui-primitives'
import { getPath } from '@shres-code/shres-code-client-schema-form'
import { providerEnabled } from './store.ts'
import type { ModelsSettingsState } from './store.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

const SEAT_IDS = ['aegis', 'stride', 'ward', 'subagent'] as const
type SeatId = (typeof SEAT_IDS)[number]

const SEAT_COLORS: Record<SeatId, string> = {
  aegis: '#c9842a',
  stride: '#2f9e62',
  ward: '#3b7dd8',
  subagent: '#6b5b95',
}

const SEAT_COPY: Record<SeatId, { name: keyof typeof en; role: keyof typeof en; description: keyof typeof en }> = {
  aegis: { name: 'seatAegisName', role: 'seatAegisRole', description: 'seatAegisDescription' },
  stride: { name: 'seatStrideName', role: 'seatStrideRole', description: 'seatStrideDescription' },
  ward: { name: 'seatWardName', role: 'seatWardRole', description: 'seatWardDescription' },
  subagent: { name: 'seatSubagentName', role: 'seatSubagentRole', description: 'seatSubagentDescription' },
}

/** One stored seat binding as the settings document carries it. */
interface SeatValue {
  provider?: string
  model?: string
  persona?: string
}

/** One custom member as the settings document carries it. */
interface MemberValue {
  name?: string
  persona?: string
  provider?: string
  model?: string
  role?: string
}

/** Seat ids with an editable persona; the generic hire has no persona. */
const NAMED_SEAT_IDS = ['aegis', 'stride', 'ward'] as const

/** Props for {@link TeamCard}. */
export interface TeamCardProps {
  /** Joined Models snapshot. */
  state: ModelsSettingsState
  /** Wire face for settings writes and the live catalog. */
  api: Pick<IApiClient, 'settings' | 'llm'>
  /** Reload the page snapshot after a write. */
  reload: () => void
  /** Section copy. */
  t: (key: keyof typeof en) => string
}

/**
 * Read one seat's stored binding from the `agent-seats` namespace value.
 * @param value - redacted section value.
 * @param id - seat id.
 * @returns the binding, or empty when unbound.
 */
export function seatValueOf(value: unknown, id: SeatId): SeatValue {
  const seats = getPath(value, ['seats', id])
  if (typeof seats !== 'object' || seats === null) return {}
  const record = seats as { provider?: unknown; model?: unknown }
  return {
    ...typeof record.provider === 'string' ? { provider: record.provider } : {},
    ...typeof record.model === 'string' ? { model: record.model } : {},
  }
}

/**
 * Bind or clear one seat. Both fields must be set for the host to remount it.
 * @param api - settings wire face.
 * @param id - seat id.
 * @param next - next binding, or undefined to unbind.
 * @returns fulfillment after the mutate settles.
 */
export async function writeSeat(
  api: Pick<IApiClient, 'settings'>,
  id: SeatId,
  next: SeatValue | undefined,
): Promise<void> {
  await api.settings.mutate({
    ns: 'agent-seats',
    ops: next === undefined
      ? [{ op: 'unset', path: ['seats', id] }]
      : [{ op: 'set', path: ['seats', id], value: next }],
  })
}


/**
 * Read the stored custom members from the `agent-seats` namespace value.
 * @param value - redacted section value.
 * @returns the member list, or empty when none are stored.
 */
export function membersOf(value: unknown): MemberValue[] {
  const extras = getPath(value, ['extras'])
  if (!Array.isArray(extras)) return []
  return extras.filter((entry): entry is MemberValue => typeof entry === 'object' && entry !== null)
}

/**
 * Store or clear one seat's persona override without touching its binding.
 * @param api - settings wire face.
 * @param id - seat id.
 * @param persona - trimmed persona text, or undefined to restore the default.
 * @returns fulfillment after the mutate settles.
 */
export async function writeSeatPersona(
  api: Pick<IApiClient, 'settings'>,
  id: SeatId,
  persona: string | undefined,
): Promise<void> {
  await api.settings.mutate({
    ns: 'agent-seats',
    ops: persona === undefined
      ? [{ op: 'unset', path: ['seats', id, 'persona'] }]
      : [{ op: 'set', path: ['seats', id, 'persona'], value: persona }],
  })
}

/**
 * Replace the stored custom-member list.
 * @param api - settings wire face.
 * @param members - complete next member list.
 * @returns fulfillment after the mutate settles.
 */
export async function writeMembers(
  api: Pick<IApiClient, 'settings'>,
  members: MemberValue[],
): Promise<void> {
  await api.settings.mutate({
    ns: 'agent-seats',
    ops: [{ op: 'set', path: ['extras'], value: members }],
  })
}

/** Lower-kebab-case member name that cannot collide with product seats. */
const MEMBER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const RESERVED_MEMBER_NAMES = new Set(['aegis', 'stride', 'ward', 'subagent', 'lead'])

/**
 * Whether one custom-member draft is complete and valid enough to store.
 * @param draft - the add-member form values.
 * @param existing - stored members the name must not duplicate.
 * @returns whether every field is usable.
 */
export function memberDraftValid(
  draft: { name: string; persona: string; provider: string; model: string },
  existing: readonly MemberValue[],
): boolean {
  const name = draft.name.trim()
  return MEMBER_NAME.test(name)
    && !RESERVED_MEMBER_NAMES.has(name)
    && !existing.some(member => member.name === name)
    && draft.persona.trim().length > 0
    && draft.provider.length > 0
    && draft.model.length > 0
}
/**
 * Render the Team card when the host exposes `agent-seats`.
 * @param props - snapshot, wire, and copy.
 * @returns the card, or null when the namespace is not exposed.
 */
export function TeamCard({ state, api, reload, t }: TeamCardProps): ReactNode {
  const namespace = state.namespaces.get('agent-seats')
  const [groups, setGroups] = useState<readonly ModelProviderGroup[]>([])
  useEffect(() => {
    if (namespace === undefined) return
    void api.llm.models({}).then((response) => {
      if (response.result.ok) setGroups(response.result.value.groups)
    })
  }, [api, namespace, state.rows])
  const [personaDrafts, setPersonaDrafts] = useState<Partial<Record<SeatId, string>>>({})
  const [openError, setOpenError] = useState(false)
  const [draft, setDraft] = useState({ name: '', persona: '', provider: '', model: '' })
  if (namespace === undefined) return null

  const enabled = new Set(
    state.rows
      .filter(row => row.entry.active && providerEnabled(row, state.namespaces))
      .map(row => row.entry.provider),
  )
  const choices = groups.filter(group => enabled.has(group.id))
  const fallback = state.rows.filter(row => enabled.has(row.entry.provider))
  const members = membersOf(namespace.value)
  const providerItems = choices.length > 0
    ? choices.map(group => ({ id: group.id, name: group.name }))
    : fallback.map(row => ({ id: row.entry.provider, name: row.entry.displayName }))

  return (
    <section className={styles['seatsCard']}>
      <div className={styles['teamHead']}>
        <div>
          <h3 className={styles['seatsTitle']}>{t('seatsTitle')}</h3>
          <p className={styles['seatsIntro']}>{t('seatsIntro')}</p>
        </div>
        <button
          type="button"
          className={styles['teamOpenDocument']}
          disabled={!state.writable}
          onClick={() => {
            api.settings.openDocument({})
              .then(() => { setOpenError(false) })
              .catch(() => { setOpenError(true) })
          }}
        >
          {t('teamOpenDocument')}
        </button>
      </div>
      {openError ? <p className={styles['teamError']} role="alert">{t('teamOpenDocumentError')}</p> : null}
      <ul className={styles['seatsList']}>
        {SEAT_IDS.map((id) => {
          const copy = SEAT_COPY[id]
          const current = seatValueOf(namespace.value, id)
          const models = choices.find(group => group.id === current.provider)?.models ?? []
          const named = (NAMED_SEAT_IDS as readonly string[]).includes(id)
          const personaDraft = personaDrafts[id] ?? current.persona ?? ''
          return (
            <li key={id} className={styles['seatRow']}>
              <div className={styles['seatIdentity']}>
                <span className={styles['seatMark']} style={{ color: SEAT_COLORS[id] }}>
                  <FishLogo size={18} />
                </span>
                <div className={styles['seatCopy']}>
                  <div className={styles['seatHeadline']}>
                    <span className={styles['seatName']}>{t(copy.name)}</span>
                    <span className={styles['seatRole']}>{t(copy.role)}</span>
                  </div>
                  <p className={styles['seatDescription']}>{t(copy.description)}</p>
                </div>
              </div>
              <div className={styles['seatFields']}>
                <label className={styles['field']}>
                  <span className={styles['fieldLabel']}>{t('seatsProvider')}</span>
                  <select
                    className={`${styles['input']} ${styles['selectInput']}`}
                    value={current.provider ?? ''}
                    aria-label={`${t(copy.name)} ${t('seatsProvider')}`}
                    disabled={!state.writable}
                    onChange={(event) => {
                      const provider = event.target.value
                      void writeSeat(
                        api,
                        id,
                        provider === '' ? undefined : { provider },
                      ).then(reload, reload)
                    }}
                  >
                    <option value="">{t('seatsUnbound')}</option>
                    {choices.length > 0
                      ? choices.map(group => (
                        <option key={group.id} value={group.id}>{group.name}</option>
                      ))
                      : fallback.map(row => (
                        <option key={row.entry.provider} value={row.entry.provider}>
                          {row.entry.displayName}
                        </option>
                      ))}
                  </select>
                </label>
                <label className={styles['field']}>
                  <span className={styles['fieldLabel']}>{t('seatsModel')}</span>
                  <select
                    className={`${styles['input']} ${styles['selectInput']}`}
                    value={current.model ?? ''}
                    aria-label={`${t(copy.name)} ${t('seatsModel')}`}
                    disabled={!state.writable || current.provider === undefined}
                    onChange={(event) => {
                      const model = event.target.value
                      if (current.provider === undefined) return
                      void writeSeat(
                        api,
                        id,
                        model === '' ? { provider: current.provider } : { provider: current.provider, model },
                      ).then(reload, reload)
                    }}
                  >
                    <option value="">{t('seatsUnbound')}</option>
                    {models.map(model => (
                      <option key={model.id} value={model.id}>{model.name}</option>
                    ))}
                    {current.model !== undefined
                      && current.model.length > 0
                      && !models.some(model => model.id === current.model)
                      ? <option value={current.model}>{current.model}</option>
                      : null}
                  </select>
                </label>
              </div>
              {named
                ? (
                  <label className={styles['seatPersona']}>
                    <span className={styles['fieldLabel']}>{t('seatsPersona')}</span>
                    <textarea
                      className={styles['personaInput']}
                      rows={3}
                      value={personaDraft}
                      placeholder={t('seatsPersonaPlaceholder')}
                      aria-label={`${t(copy.name)} ${t('seatsPersona')}`}
                      disabled={!state.writable}
                      onChange={(event) => {
                        setPersonaDrafts(drafts => ({ ...drafts, [id]: event.target.value }))
                      }}
                      onBlur={() => {
                        const stored = current.persona ?? ''
                        const next = personaDraft.trim()
                        if (next === stored.trim()) return
                        void writeSeatPersona(api, id, next === '' ? undefined : next)
                          .then(reload, reload)
                      }}
                    />
                  </label>
                )
                : null}
            </li>
          )
        })}
      </ul>
      <h4 className={styles['teamMembersTitle']}>{t('teamMembersTitle')}</h4>
      {members.length > 0
        ? (
          <ul className={styles['memberList']}>
            {members.map((member, index) => (
              <li key={member.name ?? index} className={styles['memberRow']}>
                <span className={styles['memberName']}>{member.name}</span>
                <span className={styles['memberBinding']}>{member.provider ?? '?'} / {member.model ?? '?'}</span>
                <button
                  type="button"
                  className={styles['memberRemove']}
                  aria-label={`${t('teamRemoveMember')} ${member.name ?? ''}`}
                  disabled={!state.writable}
                  onClick={() => {
                    void writeMembers(
                      api,
                      members.filter((_, at) => at !== index),
                    ).then(reload, reload)
                  }}
                >
                  {t('teamRemoveMember')}
                </button>
              </li>
            ))}
          </ul>
        )
        : <p className={styles['seatsIntro']}>{t('teamMembersEmpty')}</p>}
      <div className={styles['memberAdd']}>
        <input
          className={styles['input']}
          value={draft.name}
          placeholder={t('teamMemberName')}
          aria-label={t('teamMemberName')}
          disabled={!state.writable}
          onChange={event => setDraft(values => ({ ...values, name: event.target.value }))}
        />
        <input
          className={styles['input']}
          value={draft.persona}
          placeholder={t('teamMemberPersona')}
          aria-label={t('teamMemberPersona')}
          disabled={!state.writable}
          onChange={event => setDraft(values => ({ ...values, persona: event.target.value }))}
        />
        <select
          className={`${styles['input']} ${styles['selectInput']}`}
          value={draft.provider}
          aria-label={`${t('teamAddMember')} ${t('seatsProvider')}`}
          disabled={!state.writable}
          onChange={(event) => {
            setDraft(values => ({ ...values, provider: event.target.value, model: '' }))
          }}
        >
          <option value="">{t('seatsUnbound')}</option>
          {providerItems.map(item => (
            <option key={item.id} value={item.id}>{item.name}</option>
          ))}
        </select>
        <select
          className={`${styles['input']} ${styles['selectInput']}`}
          value={draft.model}
          aria-label={`${t('teamAddMember')} ${t('seatsModel')}`}
          disabled={!state.writable || draft.provider === ''}
          onChange={event => setDraft(values => ({ ...values, model: event.target.value }))}
        >
          <option value="">{t('seatsUnbound')}</option>
          {(choices.find(group => group.id === draft.provider)?.models ?? []).map(model => (
            <option key={model.id} value={model.id}>{model.name}</option>
          ))}
        </select>
        <button
          type="button"
          className={styles['teamOpenDocument']}
          disabled={!state.writable || !memberDraftValid(draft, members)}
          onClick={() => {
            const name = draft.name.trim()
            const persona = draft.persona.trim()
            void writeMembers(api, [
              ...members,
              { name, persona, provider: draft.provider, model: draft.model },
            ]).then(() => {
              setDraft({ name: '', persona: '', provider: '', model: '' })
              reload()
            }, reload)
          }}
        >
          {t('teamAddMember')}
        </button>
      </div>
    </section>
  )
}
