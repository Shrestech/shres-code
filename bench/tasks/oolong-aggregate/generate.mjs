/**
 * Regenerates the three OOLONG-lite tasks from the pinned seed: corpus.jsonl
 * (byte-identical across the three directories) and the seed-derived
 * instruction / expectedAnswers fields in each task.json.
 *
 * Usage: node generate.mjs
 *
 * @module bench/tasks/oolong-aggregate/generate
 */
import { writeOolongTasks } from '../oolong-lib.mjs'

const generated = writeOolongTasks()
console.log(
  `ok: seed ${generated.seed}, ${generated.rows.length} rows, `
  + `wrote oolong-aggregate, oolong-pairs, oolong-aggregate-cued`,
)
