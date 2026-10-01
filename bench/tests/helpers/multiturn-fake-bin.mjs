import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const args = process.argv.slice(2)
const overlay = await readFile(args[args.indexOf('--patch') + 1], 'utf8')
const root = JSON.parse(overlay.match(/root: ("(?:[^"\\]|\\.)*")/)[1])
const taskText = args[args.length - 1]
const sessionId = args.includes('--session-id') ? args[args.indexOf('--session-id') + 1] : args[args.indexOf('--resume') + 1]
const mode = args.includes('--session-id') ? 'create' : 'resume'
await appendFile(join(process.cwd(), 'spawn-log.txt'), JSON.stringify({ mode, sessionId }) + '\n')

const dir = join(root, 'workspace', 's1')
await mkdir(dir, { recursive: true })
const file = join(dir, 'session.jsonl')
let seq = 0
const lines = []
if (mode === 'create') {
  lines.push(JSON.stringify({ type: 'session', version: 0, id: sessionId, cwd: process.cwd(), delegationDepth: 0 }))
} else {
  const prior = await readFile(file, 'utf8')
  if (taskText.includes('REWRITE')) {
    await writeFile(file, JSON.stringify({ type: 'session', version: 0, id: 'other', cwd: '/x', delegationDepth: 0 }) + '\n')
  } else {
    for (const line of prior.trim().split('\n')) {
      const parsed = JSON.parse(line)
      if (typeof parsed.seq === 'number' && parsed.seq > seq) seq = parsed.seq
    }
  }
}
if (!taskText.includes('REWRITE')) {
  seq += 1
  lines.push(JSON.stringify({ type: 'step/start', seq, time: 1000 + seq, data: { turn: seq - 1, step: 0 } }))
  lines.push(JSON.stringify({ type: 'assistant/message', seq: seq + 1, time: 1100 + seq, data: { turn: seq - 1, step: 0, message: { role: 'assistant' }, usage: { inputTokens: 10, outputTokens: 1 } } }))
  await appendFile(file, lines.join('\n') + '\n')
}
