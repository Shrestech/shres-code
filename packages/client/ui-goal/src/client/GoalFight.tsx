/**
 * 36px Goal-strip fight: the fearless girl walks remaining units down.
 * Discrete incomplete todos are zombies; when that list is empty the
 * strip draws a standing army so the arena is never girl-only. A unit
 * leaving the list is a lunge + slash + scatter. Elapsed time is since
 * goal create, not an ETA.
 */

import { useEffect, useRef, useState } from 'react'
import { SPRITES } from './sprites.ts'
import { formatElapsed, type FightKind, type FightUnit } from './units.ts'
import css from './GoalFight.module.css'

/** Ready → step-in. */
export const FIGHT_LUNGE_MS = 220
/** Contact slash. */
export const FIGHT_SLASH_MS = 180
/** Follow-through before the corpse leaves. */
export const FIGHT_FOLLOW_MS = 420

const GIRL_HOME = 2
const FRONT = 28
const STEP = 11

const GIRL_SRC = {
  idle: SPRITES.girl_idle,
  lunge: SPRITES.girl_lunge,
  slash: SPRITES.girl_slash,
  follow: SPRITES.girl_follow,
} as const

const ZOMBIE_SRC: Record<FightKind | 'scatter', string> = {
  zombie: SPRITES.zombie,
  'zombie-2': SPRITES.zombie_2,
  'zombie-lunge': SPRITES.zombie_lunge,
  scatter: SPRITES.zombie_scatter,
}

type Pose = keyof typeof GIRL_SRC
type Life = 'alive' | 'scatter' | 'gone'

interface Drawn {
  readonly id: string
  readonly kind: FightKind
  life: Life
}

export interface GoalFightProps {
  /** Remaining discrete units (todos or the standing army), already capped. */
  units: readonly FightUnit[]
  /** Pause / block / reduced-motion: skip the lunge and freeze the shuffle. */
  frozen: boolean
  /** Goal create time in epoch ms; omitted hides the clock. */
  createdAt: number | undefined
}

/**
 * Render the fight arena and optional elapsed clock.
 * @param props - remaining units, freeze flag, and create timestamp.
 * @returns the arena plus the elapsed readout.
 */
export function GoalFight({ units, frozen, createdAt }: GoalFightProps) {
  const [drawn, setDrawn] = useState<Drawn[]>(() => units.map(u => ({ ...u, life: 'alive' })))
  const [pose, setPose] = useState<Pose>('idle')
  const [girlX, setGirlX] = useState(GIRL_HOME)
  const [elapsed, setElapsed] = useState(() => createdAt === undefined ? '' : formatElapsed(Date.now() - createdAt))
  const busy = useRef(false)
  const drawnRef = useRef(drawn)
  drawnRef.current = drawn

  useEffect(() => {
    if (createdAt === undefined) {
      setElapsed('')
      return
    }
    const tick = () => {
      setElapsed(formatElapsed(Date.now() - createdAt))
    }
    tick()
    const id = window.setInterval(tick, 1000)
    return () => { window.clearInterval(id) }
  }, [createdAt])

  useEffect(() => {
    const nextIds = new Set(units.map(u => u.id))
    const current = drawnRef.current
    const missing = current.filter(d => d.life !== 'gone' && !nextIds.has(d.id))
    const known = new Set(current.map(d => d.id))
    const spawned = units.filter(u => !known.has(u.id)).map(u => ({ ...u, life: 'alive' as const }))

    if (spawned.length > 0) {
      setDrawn(prev => [...prev.filter(d => d.life !== 'gone'), ...spawned])
    }

    if (missing.length === 0 || busy.current) return

    if (frozen || reduceMotion()) {
      setDrawn(prev => prev.filter(d => nextIds.has(d.id)))
      setPose('idle')
      return
    }

    for (const target of missing) {
      const index = Math.max(0, current.findIndex(d => d.id === target.id))
      busy.current = true
      void playKill(target.id, index)
      break
    }
  }, [units, frozen, drawn])

  return (
    <>
      <div className={css.arena} data-goal-fight aria-hidden="true">
        <img
          className={`${css.actor} ${css.girl}${pose === 'slash' || pose === 'follow' ? ` ${css.slash}` : ''}`}
          src={GIRL_SRC[pose]}
          alt=""
          draggable={false}
          style={{ left: `${String(girlX)}%` }}
          data-pose={pose}
        />
        {drawn.map((unit, i) => (
          <img
            key={unit.id}
            className={`${css.actor} ${css.zombie} ${unit.life === 'alive' && !frozen ? css.alive : css[unit.life]}`}
            src={ZOMBIE_SRC[unit.life === 'alive' ? unit.kind : 'scatter']}
            alt=""
            draggable={false}
            style={{ left: `${String(FRONT + i * STEP)}%`, zIndex: 8 - i }}
            data-unit={unit.id}
            data-life={unit.life}
          />
        ))}
      </div>
      {elapsed !== '' && <span className={css.clock} aria-hidden="true">{elapsed}</span>}
    </>
  )

  async function playKill(id: string, index: number) {
    const contact = Math.max(GIRL_HOME, FRONT + index * STEP - 14)
    setPose('lunge')
    setGirlX(contact)
    await wait(FIGHT_LUNGE_MS)
    setPose('slash')
    setDrawn(prev => prev.map(d => d.id === id ? { ...d, life: 'scatter' } : d))
    await wait(FIGHT_SLASH_MS)
    setPose('follow')
    await wait(FIGHT_FOLLOW_MS)
    setDrawn(prev => prev.filter(d => d.id !== id))
    setPose('idle')
    setGirlX(Math.min(contact, FRONT + index * STEP - 8))
    busy.current = false
  }
}

function reduceMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => { window.setTimeout(resolve, ms) })
}
