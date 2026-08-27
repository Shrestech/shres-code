/**
 * Regenerates all three OOLONG-lite tasks from the pinned seed (same as
 * `oolong-aggregate/generate.mjs`).
 *
 * Usage: node generate.mjs
 *
 * @module bench/tasks/oolong-pairs/generate
 */
import { writeOolongTasks } from '../oolong-lib.mjs'

writeOolongTasks()
console.log('ok: regenerated OOLONG-lite tasks from the pinned seed')
