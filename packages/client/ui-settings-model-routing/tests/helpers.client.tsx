/** Shared page-model doubles of the Settings › Model routing component specs. */
import { vi } from 'vitest'
import { createSnapshotStore } from '@shres-code/shres-code-client-runtime/client'
import { en } from '../src/client/locales.ts'
import type { ModelRoutingController, ModelRoutingState, WriteFailure } from '../src/client/model.ts'
import { GATE, JUDGMENT, LAYA_VIEW, ROUTER, snapshot } from './fixtures.client.ts'

/** Resolve a key the way the locale runtime does, filling {name} placeholders. */
export function t(key: keyof typeof en, params?: Record<string, unknown>): string {
  return en[key].replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name]))
}

/** A ready page state. */
export function ready(overrides: Partial<ModelRoutingState> = {}): ModelRoutingState {
  return {
    availability: 'composed',
    status: 'ready',
    error: null,
    engines: snapshot(),
    laya: LAYA_VIEW,
    layaError: null,
    layaAction: null,
    writable: true,
    judgment: JUDGMENT,
    router: ROUTER,
    gate: GATE,
    pool: null,
    models: null,
    routingError: null,
    ...overrides,
  }
}

/** A controller double over a fixed state, recording its writes. */
export function double(state: ModelRoutingState, writes: Partial<Record<'selectEngine' | 'setClassifier' | 'setDefaultMode' | 'savePool' | 'saveChildPolicies', WriteFailure | undefined>> = {}) {
  const store = createSnapshotStore(state)
  return {
    store,
    probe: vi.fn(() => Promise.resolve()),
    load: vi.fn(() => Promise.resolve()),
    refresh: vi.fn(() => Promise.resolve()),
    selectEngine: vi.fn(() => Promise.resolve(writes.selectEngine)),
    setClassifier: vi.fn(() => Promise.resolve(writes.setClassifier)),
    setDefaultMode: vi.fn(() => Promise.resolve(writes.setDefaultMode)),
    savePool: vi.fn((_candidates: unknown, _routeFrom: unknown) => Promise.resolve(writes.savePool)),
    saveChildPolicies: vi.fn(() => Promise.resolve(writes.saveChildPolicies)),
    runLaya: vi.fn(() => Promise.resolve()),
  } satisfies ModelRoutingController
}
