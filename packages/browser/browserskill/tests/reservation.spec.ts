/** Public notification reentrancy must not create or overwrite a lifecycle operation. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@shres-code/cordis'
import { expect, it } from 'vitest'
import { resolveBrowserSkillConfig } from '../src/config.ts'
import { createBrowserSkillRuntime } from '../src/runtime/supervisor.ts'
import type { BrowserSkillStartResult } from '../src/types.ts'

it('refuses a start called from the running notification of another start', async () => {
  const runtime = createBrowserSkillRuntime({
    root: join(tmpdir(), 'browserskill-unused-reservation-root'),
    config: resolveBrowserSkillConfig({}), logger: new Context().logger('browserskill-reservation'),
  })
  const nested: { value: BrowserSkillStartResult | undefined } = { value: undefined }
  let attempted = false
  runtime.subscribe((status) => {
    if (attempted || status.operation?.phase !== 'running') return
    attempted = true
    nested.value = runtime.start('close')
  })
  try {
    const outer = runtime.start('close')
    if (!outer.accepted) throw new Error('the first Close was refused')
    await outer.settled
    if (nested.value?.accepted) await nested.value.settled
    expect(nested.value).toEqual({ accepted: false, refusal: { kind: 'operation-in-progress' } })
  } finally { await runtime.dispose() }
})

it('does not repaint a new operation after publishing the previous failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'browserskill-terminal-reservation-'))
  const runtime = createBrowserSkillRuntime({
    root, config: resolveBrowserSkillConfig({}), logger: new Context().logger('browserskill-reservation'),
  }, { provision: () => Promise.reject(new Error('fixture provisioning refusal')) })
  const nested: { value: BrowserSkillStartResult | undefined } = { value: undefined }
  let returned = false
  let repainted = false
  let attempted = false
  runtime.subscribe((status) => {
    if (!attempted && status.operation?.verb === 'provision' && status.operation.phase === 'failed') {
      attempted = true
      nested.value = runtime.start('close')
      returned = true
    } else if (returned && nested.value?.accepted && status.operation?.id === nested.value.operationId
      && status.operation.phase === 'running' && status.state.kind === 'failed') {
      repainted = true
    }
  })
  try {
    const outer = runtime.start('provision')
    if (!outer.accepted) throw new Error('the first Provision was refused')
    expect((await outer.settled).phase).toBe('failed')
    expect(nested.value?.accepted).toBe(true)
    if (nested.value?.accepted) await nested.value.settled
    expect(repainted).toBe(false)
  } finally {
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
