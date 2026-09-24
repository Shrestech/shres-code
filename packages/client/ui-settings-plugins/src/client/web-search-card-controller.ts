/**
 * Staged search-provider settings and write-only credentials. Brave and
 * DeepSeek serve routine search; Perplexity serves deep research. Each
 * provider owns its settings namespace and credential reference.
 */

import type { IApiClient } from '@shres-code/shres-code-client-connection/client'
import type { SettingsScope, SnapshotStore } from '@shres-code/shres-code-client-runtime/client'
import { createSnapshotStore } from '@shres-code/shres-code-client-runtime/client'
import {
  CardForm, booleanField, numberField, textField,
  type CardActions, type CardFieldState, type CardShell,
} from './card-form.ts'

/**
 * Namespace of the DeepSeek search provider. Spelled here rather than
 * imported: a client package must not depend on a Host package.
 */
export const WEB_SEARCH_NS = 'web-search-deepseek'

/** Namespace of the attached-CLI method switches. */
export const WEB_SEARCH_METHODS_NS = 'web-search-attached-cli'

/** Namespace of the Brave search provider. */
export const WEB_SEARCH_BRAVE_NS = 'web-search-brave'

/** Namespace of the Perplexity search provider. */
export const WEB_SEARCH_PERPLEXITY_NS = 'web-search-perplexity'

/** Credential reference the DeepSeek provider resolves when the section names none. */
const DEFAULT_API_KEY_REF = 'DEEPSEEK_API_KEY'

/** Credential reference the Perplexity provider resolves when the section names none. */
const DEFAULT_PERPLEXITY_API_KEY_REF = 'PERPLEXITY_API_KEY'

/** Credential reference the Brave provider resolves when the section names none. */
const DEFAULT_BRAVE_API_KEY_REF = 'BRAVE_API_KEY'

/** Form field the credential control stages under. */
const API_KEY_FIELD = 'apiKey'

/** Fields written to the attached-CLI section. */
const METHOD_FIELDS = new Set(['grok', 'claude', 'codex', 'kimi', 'ollama', 'zai'])

/** Provider-prefixed aliases keep shared section keys distinct in one form. */
const PROVIDER_FIELDS = [
  ['Enabled', 'enabled'],
  ['BaseURL', 'baseURL'],
  ['ApiKey', API_KEY_FIELD],
] as const

/** The DeepSeek section fields this card edits. */
export interface WebSearchSettings {
  /** Credential reference naming the environment key. */
  apiKeyEnv?: string
  /** Provider endpoint; blank inherits the provider default. */
  baseURL?: string
  /** Maximum searches served within one request. */
  maxUses?: number
  /** When false, DeepSeek is omitted from the search pool. */
  enabled?: boolean
}

/** Attached-CLI method flags this card edits. */
export interface WebSearchMethods {
  /** When false, Grok is omitted from the search pool. */
  grok?: boolean
  /** When false, Claude is omitted from the search pool. */
  claude?: boolean
  /** When false, Codex is omitted from the search pool. */
  codex?: boolean
  /** When false, Kimi is omitted from the search pool. */
  kimi?: boolean
  /** When false, Ollama Cloud is omitted from the search pool. */
  ollama?: boolean
  /** When false, Z.AI is omitted from the search pool. */
  zai?: boolean
}

/** The Perplexity section fields this card edits. */
export interface WebSearchPerplexitySettings {
  /** Credential reference naming the environment key. */
  apiKeyEnv?: string
  /** Provider endpoint; blank inherits the provider default. */
  baseURL?: string
  /** When false, Perplexity is unavailable to deep_research. */
  enabled?: boolean
}

/** Brave fields edited by the card; its result count stays deployment-owned. */
export type WebSearchBraveSettings = WebSearchPerplexitySettings

/** What the credentials domain last reported, and for which reference. */
interface CredentialState {
  /** Reference this answer describes; a stale response for another one is dropped. */
  ref: string
  /** Whether the current reference has a successful metadata response. */
  known: boolean
  /** Whether any layer supplies a value for it. */
  configured: boolean
  /** Whether `credentials.set` can affect it; false disables the control. */
  writable: boolean
}

/**
 * One credential control's view of the credentials domain: it tracks the
 * state of the reference its settings section names, and every read answers
 * for the reference in force when the response lands — `apiKeyEnv` can
 * change between the request and its response, and two reads can settle out
 * of order, so an answer is published only while it still describes the
 * reference in force.
 */
class CredentialTracker {
  private state: CredentialState = { ref: '', known: false, configured: false, writable: true }

  /**
   * @param api - wire face used for the credential the section references.
   * @param refOf - the reference the section currently names.
   * @param publish - republish the card's projection after a state change.
   */
  constructor(
    private readonly api: Pick<IApiClient, 'credentials'>,
    private readonly refOf: () => string,
    private readonly publish: () => void,
  ) {}

  /** Whether credential metadata for the current reference has arrived. */
  get known(): boolean {
    return this.state.known
  }

  /** Whether the Host reports a credential configured for the tracked reference. */
  get configured(): boolean {
    return this.state.configured
  }

  /** Whether the credentials domain accepts a write for the tracked reference. */
  get writable(): boolean {
    return this.state.writable
  }

  /** Ask the credentials domain about the reference currently named. */
  async read(): Promise<void> {
    const ref = this.refOf()
    if (ref !== this.state.ref) {
      // A new reference knows nothing yet; keeping the old answer would claim
      // the key is configured under a name nobody has checked.
      this.state = { ref, known: false, configured: false, writable: true }
      this.publish()
    }
    let response: Awaited<ReturnType<IApiClient['credentials']['describe']>>
    try {
      response = await this.api.credentials.describe({ refs: [ref] })
    } catch (_credentialReadFailure) {
      // The card stays usable without this: the key control simply reports the
      // last state it knew, and a write still reaches the Host.
      return
    }
    if (!response.result.ok || ref !== this.refOf()) return
    const view = response.result.value.credentials[ref]
    const next: CredentialState = {
      ref,
      known: true,
      configured: view?.configured ?? false,
      // An unknown reference is treated as writable: the control stays usable
      // and the Host is what refuses, rather than the card guessing a refusal.
      writable: view?.writable ?? true,
    }
    if (next.known === this.state.known && next.configured === this.state.configured && next.writable === this.state.writable) return
    this.state = next
    this.publish()
  }

  /**
   * Re-read after the Host reports a change to the tracked reference.
   * @param ref - the reference the Host reports as changed.
   */
  refresh(ref: string): void {
    if (ref !== this.state.ref) return
    void this.read()
  }

  /**
   * Write a staged key, then re-read whether the Host now holds one.
   * @param value - the staged credential literal.
   * @returns whether the Host reports a configured credential afterwards.
   */
  async write(value: string): Promise<boolean> {
    try {
      await this.api.credentials.set({ ref: this.refOf(), value })
    } catch (_credentialWriteFailure) {
      // Refusals surface through the re-read below: the Host is the only
      // authority on whether the key now exists.
    }
    await this.read()
    return this.state.configured
  }
}

/** What the web-search card renders. */
export interface WebSearchCardState extends CardShell {
  /** Availability and settings writability of each independently composed provider. */
  providers: Record<'brave' | 'perplexity' | 'deepseek' | 'methods', Pick<CardShell, 'available' | 'writable' | 'dirty'>>
  /** Brave method switch. */
  brave: CardFieldState
  /** Brave endpoint. */
  braveBaseURL: CardFieldState
  /** Staged Brave credential; reads never return the stored value. */
  braveApiKey: CardFieldState
  /** Whether the Brave credential reference has a value. */
  braveApiKeyConfigured: boolean
  /** Whether Brave credential metadata has arrived. */
  braveApiKeyKnown: boolean
  /** Whether the Brave credential reference accepts writes. */
  braveApiKeyWritable: boolean
  /** Grok method switch. */
  grok: CardFieldState
  /** Claude method switch. */
  claude: CardFieldState
  /** Codex method switch. */
  codex: CardFieldState
  /** Kimi method switch. */
  kimi: CardFieldState
  /** Ollama Cloud method switch. */
  ollama: CardFieldState
  /** Z.AI method switch. */
  zai: CardFieldState
  /** DeepSeek method switch. */
  deepseek: CardFieldState
  /** DeepSeek endpoint. */
  baseURL: CardFieldState
  /** Searches allowed per request. */
  maxUses: CardFieldState
  /** The staged DeepSeek credential, which starts blank on every load. */
  apiKey: CardFieldState
  /** Whether the Host reports a credential configured for the referenced key. */
  apiKeyConfigured: boolean
  /** Whether DeepSeek credential metadata has arrived. */
  apiKeyKnown: boolean
  /** Whether the credentials domain accepts a write for it; false disables the control. */
  apiKeyWritable: boolean
  /** Perplexity method switch. */
  perplexity: CardFieldState
  /** Perplexity endpoint. */
  perplexityBaseURL: CardFieldState
  /** The staged Perplexity credential, which starts blank on every load. */
  perplexityApiKey: CardFieldState
  /** Whether the Host reports a credential configured for the Perplexity reference. */
  perplexityApiKeyConfigured: boolean
  /** Whether Perplexity credential metadata has arrived. */
  perplexityApiKeyKnown: boolean
  /** Whether the credentials domain accepts a write for the Perplexity reference. */
  perplexityApiKeyWritable: boolean
}

/** The registration-side face the web-search card's slot entry injects. */
export interface WebSearchCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useWebSearchCard. */
    webSearchCard: SnapshotStore<WebSearchCardState>
  }
}

const OFF: CardFieldState = { text: 'false', overridden: false, invalid: false }

/** Bridges independently composed search namespaces and write-only credentials. */
export class WebSearchCardController {
  private readonly form: CardForm<WebSearchSettings>
  private readonly methods: CardForm<WebSearchMethods>
  private readonly perplexityForm: CardForm<WebSearchPerplexitySettings>
  private readonly braveForm: CardForm<WebSearchBraveSettings>
  private readonly providerFields = new Map<string, { actions: CardActions; field: string }>()
  private readonly store: SnapshotStore<WebSearchCardState>
  private readonly credential: CredentialTracker
  private readonly perplexityCredential: CredentialTracker
  private readonly braveCredential: CredentialTracker

  /**
   * @param scope - the bound settings scope for the DeepSeek namespace.
   * @param api - wire face used for the credentials the sections reference.
   * @param methodsScope - the bound settings scope for CLI method switches.
   * @param perplexityScope - the bound settings scope for the Perplexity namespace.
   * @param braveScope - the bound settings scope for the Brave namespace.
   */
  constructor(
    scope: SettingsScope<WebSearchSettings>,
    api: Pick<IApiClient, 'credentials'>,
    methodsScope: SettingsScope<WebSearchMethods>,
    perplexityScope: SettingsScope<WebSearchPerplexitySettings>,
    braveScope: SettingsScope<WebSearchBraveSettings>,
  ) {
    this.form = new CardForm(
      scope,
      [textField('baseURL'), numberField('maxUses'), booleanField('enabled')],
      [{ field: API_KEY_FIELD, write: text => this.credential.write(text) }],
    )
    this.methods = new CardForm(methodsScope, [
      booleanField('grok'),
      booleanField('claude'),
      booleanField('codex'),
      booleanField('kimi'),
      booleanField('ollama'),
      booleanField('zai'),
    ])
    this.perplexityForm = new CardForm(
      perplexityScope,
      [textField('baseURL'), booleanField('enabled')],
      [{ field: API_KEY_FIELD, write: text => this.perplexityCredential.write(text) }],
    )
    this.braveForm = new CardForm(
      braveScope,
      [textField('baseURL'), booleanField('enabled')],
      [{ field: API_KEY_FIELD, write: text => this.braveCredential.write(text) }],
    )
    for (const [prefix, actions] of [
      ['perplexity', this.perplexityForm.actions()],
      ['brave', this.braveForm.actions()],
    ] as const) {
      for (const [suffix, field] of PROVIDER_FIELDS) {
        this.providerFields.set(`${prefix}${suffix}`, { actions, field })
      }
    }
    // The trackers precede the store: the store's first projection already
    // reads their state, while their publish callback defers to a method that
    // only runs once the store exists.
    this.credential = new CredentialTracker(
      api,
      () => refOf(scope.getSnapshot().value?.apiKeyEnv, DEFAULT_API_KEY_REF),
      () => { this.publishProjection() },
    )
    this.perplexityCredential = new CredentialTracker(
      api,
      () => refOf(perplexityScope.getSnapshot().value?.apiKeyEnv, DEFAULT_PERPLEXITY_API_KEY_REF),
      () => { this.publishProjection() },
    )
    this.braveCredential = new CredentialTracker(
      api,
      () => refOf(braveScope.getSnapshot().value?.apiKeyEnv, DEFAULT_BRAVE_API_KEY_REF),
      () => { this.publishProjection() },
    )
    this.store = createSnapshotStore(this.projection())
    const push = (): WebSearchCardState => {
      const next = this.projection()
      this.store.set(next)
      return next
    }
    this.form.bind(push)
    this.methods.bind(push)
    this.perplexityForm.bind(push)
    this.braveForm.bind(push)
    scope.subscribe(() => { void this.credential.read() })
    perplexityScope.subscribe(() => { void this.perplexityCredential.read() })
    braveScope.subscribe(() => { void this.braveCredential.read() })
    void this.credential.read()
    void this.perplexityCredential.read()
    void this.braveCredential.read()
  }

  /** Rebuild the card's projection and publish it through the store. */
  private publishProjection(): void {
    this.store.set(this.projection())
  }

  private projection(): WebSearchCardState {
    const deepseek = this.form.shell()
    const perplexity = this.perplexityForm.shell()
    const methods = this.methods.shell()
    const brave = this.braveForm.shell()
    const providers = { brave, perplexity, deepseek, methods }
    const shells = Object.values(providers)
    return {
      providers,
      available: shells.some(shell => shell.available),
      writable: shells.some(shell => shell.available && shell.writable),
      dirty: shells.some(shell => shell.dirty),
      invalid: shells.some(shell => shell.invalid),
      saving: shells.some(shell => shell.saving),
      failed: shells.some(shell => shell.failed),
      brave: brave.available ? this.braveForm.field('enabled') : OFF,
      braveBaseURL: this.braveForm.field('baseURL'),
      braveApiKey: this.braveForm.field(API_KEY_FIELD),
      braveApiKeyConfigured: this.braveCredential.configured,
      braveApiKeyKnown: this.braveCredential.known,
      braveApiKeyWritable: this.braveCredential.writable,
      grok: methods.available ? this.methods.field('grok') : OFF,
      claude: methods.available ? this.methods.field('claude') : OFF,
      codex: methods.available ? this.methods.field('codex') : OFF,
      kimi: methods.available ? this.methods.field('kimi') : OFF,
      ollama: methods.available ? this.methods.field('ollama') : OFF,
      zai: methods.available ? this.methods.field('zai') : OFF,
      deepseek: deepseek.available ? this.form.field('enabled') : OFF,
      baseURL: this.form.field('baseURL'),
      maxUses: this.form.field('maxUses'),
      apiKey: this.form.field(API_KEY_FIELD),
      apiKeyConfigured: this.credential.configured,
      apiKeyKnown: this.credential.known,
      apiKeyWritable: this.credential.writable,
      perplexity: perplexity.available ? this.perplexityForm.field('enabled') : OFF,
      perplexityBaseURL: this.perplexityForm.field('baseURL'),
      perplexityApiKey: this.perplexityForm.field(API_KEY_FIELD),
      perplexityApiKeyConfigured: this.perplexityCredential.configured,
      perplexityApiKeyKnown: this.perplexityCredential.known,
      perplexityApiKeyWritable: this.perplexityCredential.writable,
    }
  }

  /**
   * Re-read after the Host reports a change to a reference this card watches.
   *
   * A key can be written from somewhere else — the Models page addresses the
   * same references — and the settings sections do not change when one is, so
   * without this the badges keep reporting a state the Host already replaced.
   * @param ref - the reference the Host reports as changed.
   */
  refreshCredential(ref: string): void {
    this.credential.refresh(ref)
    this.perplexityCredential.refresh(ref)
    this.braveCredential.refresh(ref)
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its form actions.
   */
  inject(): WebSearchCardFace {
    const deepseek = this.form.actions()
    const perplexity = this.perplexityForm.actions()
    const brave = this.braveForm.actions()
    const methods = this.methods.actions()
    return {
      hooks: { webSearchCard: this.store },
      edit: (field, text) => {
        if (METHOD_FIELDS.has(field)) {
          methods.edit(field, text)
          return
        }
        const providerField = this.providerFields.get(field)
        if (providerField !== undefined) providerField.actions.edit(providerField.field, text)
        else deepseek.edit(field, text)
      },
      resetField: (field) => {
        if (METHOD_FIELDS.has(field)) {
          methods.resetField(field)
          return
        }
        const providerField = this.providerFields.get(field)
        if (providerField !== undefined) providerField.actions.resetField(providerField.field)
        else deepseek.resetField(field)
      },
      save: () => {
        deepseek.save()
        perplexity.save()
        brave.save()
        methods.save()
      },
      discard: () => {
        deepseek.discard()
        perplexity.discard()
        brave.discard()
        methods.discard()
      },
    }
  }
}

/**
 * The credential reference a section names, or its provider's default.
 * @param declared - the section's `apiKeyEnv`, when it carries one.
 * @param fallback - the provider's default reference.
 * @returns the reference to address.
 */
function refOf(declared: string | undefined, fallback: string): string {
  return declared !== undefined && declared.length > 0 ? declared : fallback
}
