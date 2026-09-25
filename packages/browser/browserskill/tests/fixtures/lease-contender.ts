/** Real-process contender for the runtime lease regression. No browser or daemon is launched. */
import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { acquireRuntimeLease, type HeldRuntimeLease } from '../../src/runtime/lease.ts'
import { isOwnedChromeProcess } from '../../src/runtime/process-group.ts'

const root = process.argv[2]!
const before = JSON.parse(await readFile(join(root, 'runtime.lock'), 'utf8')) as { daemonPid: number }
let lease: HeldRuntimeLease | undefined
process.on('message', (message) => {
  void (async () => {
    if (message === 'acquire') {
      try {
        lease = await acquireRuntimeLease(root, {
          browserIsOurs: (pid, ms) => isOwnedChromeProcess(pid, join(root, 'profile'), ms),
          daemonIsOurs: async pid => pid === before.daemonPid,
          killBrowser: async (pid) => {
            await appendFile(join(root, 'stopped.log'), `browser:${pid}${String.fromCharCode(10)}`)
            process.kill(pid, 'SIGKILL')
          },
          stopDaemon: async () => {
            await appendFile(join(root, 'stopped.log'), `daemon:${before.daemonPid}${String.fromCharCode(10)}`)
            process.kill(before.daemonPid, 'SIGKILL')
          },
        })
        process.send!({ accepted: true, leaseId: lease.content().leaseId, pid: process.pid })
      } catch (error) {
        process.send!({ accepted: false, message: String(error) })
      }
    } else if (message === 'release') {
      await lease?.release()
      process.send!({ released: true })
    }
  })().catch((error: unknown) => {
    process.send!({ error: String(error) })
    process.exitCode = 1
    process.disconnect!()
  })
})
process.send!({ ready: true })
