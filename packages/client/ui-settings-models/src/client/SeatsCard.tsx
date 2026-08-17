/**
 * Models-page card that binds Aegis, Stride, and Ward to enabled providers.
 */

import { useEffect, useState, type ReactNode } from 'react'
import type { IApiClient, ModelProviderGroup } from '@shres-code/shres-code-api-remotes/client'
import { FishLogo } from '@shres-code/shres-code-client-ui-primitives'
import { getPath } from '@shres-code/shres-code-client-schema-form'
import { providerEnabled } from './store.ts'
import type { ModelsSettingsState } from './store.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

const SEAT_IDS = ['aegis', 'stride', 'ward'] as const
type SeatId = (typeof SEAT_IDS)[number]

const SEAT_COLORS: Record<SeatId, string> = {
  aegis: '#c9842a',
  stride: '#2f9e62',
  ward: '#3b7dd8',
}

const SEAT_COPY: Record<SeatId, { name: keyof typeof en; role: keyof typeof en; description: keyof typeof en }> = {
  aegis: { name: 'seatAegisName', role: 'seatAegisRole', description: 'seatAegisDescription' },
  stride: { name: 'seatStrideName', role: 'seatStrideRole', description: 'seatStrideDescription' },
  ward: { name: 'seatWardName', role: 'seatWardRole', description: 'seatWardDescription' },
}

/** One stored seat binding as the settings document carries it. */
interface SeatValue {
  provider?: string
  model?: string
}

/** Props for {@link SeatsCard}. */
export interface SeatsCardProps {
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
 * Render the seats card when the host exposes `agent-seats`.
 * @param props - snapshot, wire, and copy.
 * @returns the card, or null when the namespace is not exposed.
 */
export function SeatsCard({ state, api, reload, t }: SeatsCardProps): ReactNode {
  const namespace = state.namespaces.get('agent-seats')
  const [groups, setGroups] = useState<readonly ModelProviderGroup[]>([])
  useEffect(() => {
    if (namespace === undefined) return
    void api.llm.models({}).then((response) => {
      if (response.result.ok) setGroups(response.result.value.groups)
    })
  }, [api, namespace, state.rows])
  if (namespace === undefined) return null

  const enabled = new Set(
    state.rows
      .filter(row => row.entry.active && providerEnabled(row, state.namespaces))
      .map(row => row.entry.provider),
  )
  const choices = groups.filter(group => enabled.has(group.id))
  const fallback = state.rows.filter(row => enabled.has(row.entry.provider))

  return (
    <section className={styles['seatsCard']}>
      <h3 className={styles['seatsTitle']}>{t('seatsTitle')}</h3>
      <p className={styles['seatsIntro']}>{t('seatsIntro')}</p>
      <ul className={styles['seatsList']}>
        {SEAT_IDS.map((id) => {
          const copy = SEAT_COPY[id]
          const current = seatValueOf(namespace.value, id)
          const models = choices.find(group => group.id === current.provider)?.models ?? []
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
            </li>
          )
        })}
      </ul>
    </section>
  )
}
