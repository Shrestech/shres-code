/**
 * Team settings roster: the three named seats with model bindings, the
 * generic Subagent hire, and user-added custom members.
 * A wrap-text control next to each product-seat role opens that seat's
 * shipped roster persona. Everything writes to the `agent-seats` settings
 * namespace.
 */

import { useEffect, useState, type ReactNode } from 'react'
import type { IApiClient, ModelProviderGroup } from '@shres-code/shres-code-api-remotes/client'
import { IconAgentPresetOutline16 } from '@shres-code/shres-code-client-ui-primitives'
import { getPath } from '@shres-code/shres-code-client-schema-form'
import { providerEnabled } from './store.ts'
import type { ModelsSettingsState } from './store.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

const SEAT_IDS = ['aegis', 'stride', 'ward', 'subagent'] as const
type SeatId = (typeof SEAT_IDS)[number]
const NAMED_SEAT_IDS = ['aegis', 'stride', 'ward'] as const
type NamedSeatId = (typeof NAMED_SEAT_IDS)[number]

const SEAT_COPY: Record<SeatId, { name: keyof typeof en; role: keyof typeof en; description: keyof typeof en }> = {
  aegis: { name: 'seatAegisName', role: 'seatAegisRole', description: 'seatAegisDescription' },
  stride: { name: 'seatStrideName', role: 'seatStrideRole', description: 'seatStrideDescription' },
  ward: { name: 'seatWardName', role: 'seatWardRole', description: 'seatWardDescription' },
  subagent: { name: 'seatSubagentName', role: 'seatSubagentRole', description: 'seatSubagentDescription' },
}

const SEAT_PERSONA: Record<NamedSeatId, keyof typeof en> = {
  aegis: 'seatAegisPersona',
  stride: 'seatStridePersona',
  ward: 'seatWardPersona',
}

/**
 * Whether this Models seat is a product teammate with a shipped persona.
 * @param id - seat id including the generic hire.
 * @returns true for Aegis, Stride, and Ward.
 */
function isNamedSeat(id: SeatId): id is NamedSeatId {
  return (NAMED_SEAT_IDS as readonly string[]).includes(id)
}

/** Wrap-text glyph next to a product-seat role; click opens the roster persona. */
function WrapTextIcon(): ReactNode {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M2 3.25h10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M2 6.75h10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M2 10.25h5.25" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path
        d="M10.25 9.25v.85c0 .72.58 1.3 1.3 1.3H12.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path
        d="M11.55 12.55 12.75 11.4l-1.2-1.15"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** One stored seat binding as the settings document carries it. */
interface SeatValue {
  provider?: string
  model?: string
}

/** One custom member as the settings document carries it. */
interface MemberValue {
  name?: string
  persona?: string
  provider?: string
  model?: string
  role?: string
}

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
 * Bind or clear one seat's provider and model as field path ops. Both
 * provider and model must be set for the host to remount it.
 * @param api - settings wire face.
 * @param id - seat id.
 * @param next - next binding, or undefined to clear provider and model.
 * @returns fulfillment after the mutate settles.
 */
export async function writeSeat(
  api: Pick<IApiClient, 'settings'>,
  id: SeatId,
  next: SeatValue | undefined,
): Promise<void> {
  const provider = next?.provider
  const model = next?.model
  await api.settings.mutate({
    ns: 'agent-seats',
    ops: [
      provider === undefined
        ? { op: 'unset', path: ['seats', id, 'provider'] }
        : { op: 'set', path: ['seats', id, 'provider'], value: provider },
      model === undefined
        ? { op: 'unset', path: ['seats', id, 'model'] }
        : { op: 'set', path: ['seats', id, 'model'], value: model },
    ],
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
  draft: { name: string; persona: string; provider: string; model: string; role?: string },
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
 * Render the Team roster when the host exposes `agent-seats`.
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
  const [draft, setDraft] = useState({ name: '', role: '', persona: '', provider: '', model: '' })
  const [openPersonas, setOpenPersonas] = useState<Partial<Record<NamedSeatId, boolean>>>({})
  const [openMembers, setOpenMembers] = useState<ReadonlySet<number>>(() => new Set())
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
    <div className={styles['seatsCard']}>
      <h3 className={styles['seatsTitle']}>{t('seatsTitle')}</h3>
      <p className={styles['seatsIntro']}>{t('seatsIntro')}</p>
      <ul className={styles['seatsList']}>
        {SEAT_IDS.map((id) => {
          const copy = SEAT_COPY[id]
          const current = seatValueOf(namespace.value, id)
          const models = choices.find(group => group.id === current.provider)?.models ?? []
          const named = isNamedSeat(id)
          const personaOpen = named && openPersonas[id] === true
          return (
            <li key={id} className={styles['seatRow']}>
              <div className={styles['seatIdentity']}>
                <span className={styles['seatMark']} data-seat={id}>
                  <IconAgentPresetOutline16 size={16} />
                </span>
                <div className={styles['seatCopy']}>
                  <div className={styles['seatHeadline']}>
                    <span className={styles['seatName']}>{t(copy.name)}</span>
                    <span className={styles['seatRole']}>{t(copy.role)}</span>
                    {named
                      ? (
                        <button
                          type="button"
                          className={styles['seatPersonaButton']}
                          aria-label={`${t(copy.name)} ${t('seatsPersona')}`}
                          aria-expanded={personaOpen}
                          onClick={() => {
                            setOpenPersonas(open => ({ ...open, [id]: !personaOpen }))
                          }}
                        >
                          <WrapTextIcon />
                        </button>
                      )
                      : null}
                  </div>
                  <p className={styles['seatDescription']}>{t(copy.description)}</p>
                  {named && personaOpen
                    ? <p className={styles['seatPersona']}>{t(SEAT_PERSONA[id])}</p>
                    : null}
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
                <div className={styles['memberIdentity']}>
                  <div className={styles['memberHeadline']}>
                    <span className={styles['memberName']}>{member.name ?? t('teamMemberUnnamed')}</span>
                    {typeof member.role !== 'string' || member.role.length === 0
                      ? null
                      : <span className={styles['memberRole']}>{member.role}</span>}
                    {typeof member.persona === 'string' && member.persona.length > 0
                      ? (
                        <button
                          type="button"
                          className={styles['memberPersonaButton']}
                          aria-label={`${member.name ?? t('teamMemberUnnamed')} ${t('teamMemberPersonaToggle')}`}
                          aria-expanded={openMembers.has(index)}
                          onClick={() => {
                            setOpenMembers((current) => {
                              const next = new Set(current)
                              if (next.has(index)) next.delete(index)
                              else next.add(index)
                              return next
                            })
                          }}
                        >
                          <WrapTextIcon />
                        </button>
                      )
                      : null}
                  </div>
                  <span className={styles['memberBinding']}>{member.provider ?? '?'} / {member.model ?? '?'}</span>
                  {openMembers.has(index) && typeof member.persona === 'string' && member.persona.length > 0
                    ? <p className={styles['memberPersona']}>{member.persona}</p>
                    : null}
                </div>
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
          onChange={(event) => { setDraft(values => ({ ...values, name: event.target.value })) }}
        />
        <input
          className={styles['input']}
          value={draft.role}
          placeholder={t('teamMemberRole')}
          aria-label={t('teamMemberRole')}
          disabled={!state.writable}
          onChange={(event) => { setDraft(values => ({ ...values, role: event.target.value })) }}
        />
        <input
          className={styles['input']}
          value={draft.persona}
          placeholder={t('teamMemberPersona')}
          aria-label={t('teamMemberPersona')}
          disabled={!state.writable}
          onChange={(event) => { setDraft(values => ({ ...values, persona: event.target.value })) }}
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
          onChange={(event) => { setDraft(values => ({ ...values, model: event.target.value })) }}
        >
          <option value="">{t('seatsUnbound')}</option>
          {(choices.find(group => group.id === draft.provider)?.models ?? []).map(model => (
            <option key={model.id} value={model.id}>{model.name}</option>
          ))}
        </select>
        <button
          type="button"
          className={styles['secondaryButton']}
          disabled={!state.writable || !memberDraftValid(draft, members)}
          onClick={() => {
            const name = draft.name.trim()
            const persona = draft.persona.trim()
            void writeMembers(api, [
              ...members,
              {
                name,
                persona,
                provider: draft.provider,
                model: draft.model,
                ...draft.role.trim().length > 0 ? { role: draft.role.trim() } : {},
              },
            ]).then(() => {
              setDraft({ name: '', role: '', persona: '', provider: '', model: '' })
              reload()
            }, reload)
          }}
        >
          {t('teamAddMember')}
        </button>
      </div>
    </div>
  )
}
