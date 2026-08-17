/**
 * The web-search card's staged form: method switches plus the DeepSeek
 * endpoint, budget, and key.
 *
 * CLI method flags live on `web-search-attached-cli`. DeepSeek's enable flag,
 * endpoint, and budget live on `web-search-deepseek`. The key is written
 * through the credentials domain, never into a settings section.
 */

import type { IApiClient } from '@shres-code/shres-code-client-connection/client'
import type { SettingsScope, SettingsScopeSnapshot, SnapshotStore } from '@shres-code/shres-code-client-runtime/client'
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

/** Credential reference the provider resolves when the section names none. */
const DEFAULT_API_KEY_REF = 'DEEPSEEK_API_KEY'

/** Form field the credential control stages under. */
const API_KEY_FIELD = 'apiKey'

/** Fields written to the attached-CLI section. */
const METHOD_FIELDS = new Set(['grok', 'claude', 'codex', 'kimi', 'ollama'])

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
}

/** What the credentials domain last reported, and for which reference. */
interface CredentialState {
  /** Reference this answer describes; a stale response for another one is dropped. */
  ref: string
  /** Whether any layer supplies a value for it. */
  configured: boolean
  /** Whether `credentials.set` can affect it; false disables the control. */
  writable: boolean
}

/** What the web-search card renders. */
export interface WebSearchCardState extends CardShell {
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
  /** DeepSeek method switch. */
  deepseek: CardFieldState
  /** Provider endpoint. */
  baseURL: CardFieldState
  /** Searches allowed per request. */
  maxUses: CardFieldState
  /** The staged credential, which starts blank on every load. */
  apiKey: CardFieldState
  /** Whether the Host reports a credential configured for the referenced key. */
  apiKeyConfigured: boolean
  /** Whether the credentials domain accepts a write for it; false disables the control. */
  apiKeyWritable: boolean
}

/** The registration-side face the web-search card's slot entry injects. */
export interface WebSearchCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useWebSearchCard. */
    webSearchCard: SnapshotStore<WebSearchCardState>
  }
}

const ON: CardFieldState = { text: 'true', overridden: false, invalid: false }

/** Bridges both search namespaces and the credentials domain onto the card. */
export class WebSearchCardController {
  private readonly form: CardForm<WebSearchSettings>
  private readonly methods: CardForm<WebSearchMethods>
  private readonly store: SnapshotStore<WebSearchCardState>
  private credential: CredentialState = { ref: '', configured: false, writable: true }

  /**
   * @param scope - the bound settings scope for the DeepSeek namespace.
   * @param api - wire face used for the credential the section references.
   * @param methodsScope - the bound settings scope for CLI method switches.
   */
  constructor(
    private readonly scope: SettingsScope<WebSearchSettings>,
    private readonly api: Pick<IApiClient, 'credentials'>,
    methodsScope: SettingsScope<WebSearchMethods>,
  ) {
    this.form = new CardForm(
      scope,
      [textField('baseURL'), numberField('maxUses'), booleanField('enabled')],
      [{ field: API_KEY_FIELD, write: text => this.writeKey(text) }],
    )
    this.methods = new CardForm(methodsScope, [
      booleanField('grok'),
      booleanField('claude'),
      booleanField('codex'),
      booleanField('kimi'),
      booleanField('ollama'),
    ])
    this.store = createSnapshotStore(this.projection())
    const push = (): WebSearchCardState => {
      const next = this.projection()
      this.store.set(next)
      return next
    }
    this.form.bind(push)
    this.methods.bind(push)
    scope.subscribe(() => { void this.readCredential() })
    void this.readCredential()
  }

  private projection(): WebSearchCardState {
    const deepseek = this.form.shell()
    const methods = this.methods.shell()
    return {
      available: deepseek.available || methods.available,
      writable: deepseek.writable && (methods.available ? methods.writable : true),
      dirty: deepseek.dirty || methods.dirty,
      invalid: deepseek.invalid || methods.invalid,
      saving: deepseek.saving || methods.saving,
      failed: deepseek.failed || methods.failed,
      grok: methods.available ? this.methods.field('grok') : ON,
      claude: methods.available ? this.methods.field('claude') : ON,
      codex: methods.available ? this.methods.field('codex') : ON,
      kimi: methods.available ? this.methods.field('kimi') : ON,
      ollama: methods.available ? this.methods.field('ollama') : ON,
      deepseek: deepseek.available ? this.form.field('enabled') : ON,
      baseURL: this.form.field('baseURL'),
      maxUses: this.form.field('maxUses'),
      apiKey: this.form.field(API_KEY_FIELD),
      apiKeyConfigured: this.credential.configured,
      apiKeyWritable: this.credential.writable,
    }
  }

  /**
   * Ask the credentials domain about the reference the section currently names.
   *
   * The answer is stored with the reference it describes: `apiKeyEnv` can
   * change between the request and its response, and two reads can settle out
   * of order, so a response is published only while it still answers for the
   * reference in force.
   */
  private async readCredential(): Promise<void> {
    const ref = refOf(this.scope.getSnapshot())
    if (ref !== this.credential.ref) {
      // A new reference knows nothing yet; keeping the old answer would claim
      // the key is configured under a name nobody has checked.
      this.credential = { ref, configured: false, writable: true }
      this.store.set(this.projection())
    }
    let response: Awaited<ReturnType<IApiClient['credentials']['describe']>>
    try {
      response = await this.api.credentials.describe({ refs: [ref] })
    } catch (_credentialReadFailure) {
      // The card stays usable without this: the key control simply reports the
      // last state it knew, and a write still reaches the Host.
      return
    }
    if (!response.result.ok || ref !== refOf(this.scope.getSnapshot())) return
    const view = response.result.value.credentials[ref]
    const next: CredentialState = {
      ref,
      configured: view?.configured ?? false,
      // An unknown reference is treated as writable: the control stays usable
      // and the Host is what refuses, rather than the card guessing a refusal.
      writable: view?.writable ?? true,
    }
    if (next.configured === this.credential.configured && next.writable === this.credential.writable) return
    this.credential = next
    this.store.set(this.projection())
  }

  /**
   * Re-read after the Host reports a change to the reference this card watches.
   *
   * A key can be written from somewhere else — the Models page addresses the
   * same reference — and the settings section does not change when it is, so
   * without this the badge keeps reporting a state the Host already replaced.
   * @param ref - the reference the Host reports as changed.
   */
  refreshCredential(ref: string): void {
    if (ref !== this.credential.ref) return
    void this.readCredential()
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its form actions.
   */
  inject(): WebSearchCardFace {
    const deepseek = this.form.actions()
    const methods = this.methods.actions()
    return {
      hooks: { webSearchCard: this.store },
      edit: (field, text) => {
        if (METHOD_FIELDS.has(field)) methods.edit(field, text)
        else deepseek.edit(field, text)
      },
      resetField: (field) => {
        if (METHOD_FIELDS.has(field)) methods.resetField(field)
        else deepseek.resetField(field)
      },
      save: () => {
        deepseek.save()
        methods.save()
      },
      discard: () => {
        deepseek.discard()
        methods.discard()
      },
    }
  }

  /**
   * Write the staged key, then re-read whether the Host now holds one.
   * @param value - the staged credential literal.
   * @returns whether the Host reports a configured credential afterwards.
   */
  private async writeKey(value: string): Promise<boolean> {
    try {
      await this.api.credentials.set({ ref: refOf(this.scope.getSnapshot()), value })
    } catch (_credentialWriteFailure) {
      // Refusals surface through the re-read below: the Host is the only
      // authority on whether the key now exists.
    }
    await this.readCredential()
    return this.credential.configured
  }
}

/**
 * The credential reference the section names, or the provider's default.
 * @param snapshot - the current scope snapshot.
 * @returns the reference to address.
 */
function refOf(snapshot: SettingsScopeSnapshot<WebSearchSettings>): string {
  const declared = snapshot.value?.apiKeyEnv
  return declared !== undefined && declared.length > 0 ? declared : DEFAULT_API_KEY_REF
}
