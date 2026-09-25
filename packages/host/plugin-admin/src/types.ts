/**
 * Wire vocabulary of the pluginAdmin Remote namespace: gesture requests and
 * grants, the parked install transaction view, and the outcome unions the UI
 * branches on. Core-owned install types (preview, refusal, rollback report,
 * commit receipt, plugin state) are re-exported from their app-boot home so
 * the wire projection and the core share one declaration.
 * @module @shres-code/shres-code-host-plugin-admin/types
 */

import type { Branded } from '@shres-code/shres-code-brand'
import type {
  InstallCommitted,
  InstallPreview,
  InstallRefusal,
  PluginStateEntry,
  RemoveOutcome,
  RollbackReport,
} from '@shres-code/shres-code-app-boot/plugin-types'
import type { SkillSource } from '@shres-code/shres-code-skill/types'

export type { InstallCommitted, InstallPreview, InstallRefusal, PluginStateEntry, RemoveOutcome, RollbackReport }

/** The mutations a pluginAdmin user gesture can authorize. */
export type PluginAdminGestureVerb = 'install' | 'remove' | 'skill-add' | 'skill-remove'

/** Opaque single-use grant from `pluginAdmin/begin`; the wire form is a 32-character hex string. */
export type PluginGestureToken = Branded<'PluginGestureToken'>

/** Opaque id of one parked install transaction; the wire form is a 32-character hex string. */
export type PluginTransactionId = Branded<'PluginTransactionId'>

/** Opaque single-use token that confirms or cancels one parked transaction. */
export type PluginConfirmToken = Branded<'PluginConfirmToken'>

/**
 * Whether this host may install or remove profile plugins. `'unsupported'`
 * marks a host with no executable plugin-install owner for its profile: the
 * packaged desktop, or a composition whose launcher provided no
 * `profileRuntime`. Skill add and remove stay available in both states.
 */
export type PluginMutations = 'enabled' | 'unsupported'

/** Wire grant from `pluginAdmin/begin`: spendable on exactly one matching mutation. */
export interface PluginGestureGrant {
  /** Single-use token bound to the requested verb and target. */
  token: PluginGestureToken
  /** ISO 8601 deadline after which the grant is dead. */
  expiresAt: string
}

/** Wire request for `pluginAdmin/begin`: the gesture to authorize. */
export interface PluginAdminBeginRequest {
  /** The mutation verb to authorize. */
  verb: PluginAdminGestureVerb
  /** The install spec, plugin name, skill source path, or skill name the verb targets. */
  target: string
}

/** Wire request for `pluginAdmin/stageInstall`. */
export interface PluginAdminInstallRequest {
  /** Grant from `begin({ verb: 'install', target: spec })`. */
  token: PluginGestureToken
  /** A registry, git, or tarball spec, or an absolute local directory; relative paths are refused. */
  spec: string
}

/** Wire request for `pluginAdmin/confirm` and `pluginAdmin/cancel`. */
export interface PluginAdminSettleRequest {
  /** Confirm token returned by the parked `stageInstall` outcome. */
  token: PluginConfirmToken
}

/** Wire request for `pluginAdmin/removePlugin`. */
export interface PluginAdminRemoveRequest {
  /** Grant from `begin({ verb: 'remove', target: name })`. */
  token: PluginGestureToken
  /** The bundle package name to remove from the booted profile. */
  name: string
}

/** Wire request for `pluginAdmin/skillAdd`. */
export interface PluginAdminSkillAddRequest {
  /** Grant from `begin({ verb: 'skill-add', target: path })`. */
  token: PluginGestureToken
  /** Local directory (or flat `.md` file) holding the skill to install. */
  path: string
}

/** Wire request for `pluginAdmin/skillRemove`. */
export interface PluginAdminSkillRemoveRequest {
  /** Grant from `begin({ verb: 'skill-remove', target: name })`. */
  token: PluginGestureToken
  /** The installed skill name to remove. */
  name: string
}

/** One parked install transaction as `status` reports it. */
export interface ParkedTransactionView {
  /** Opaque transaction id; settling needs the confirm token, not this id. */
  transactionId: PluginTransactionId
  /** The preview the parked install is awaiting consent for. */
  preview: InstallPreview
}

/** One user-installed skill, plus the live-catalog skill that outranks it when one exists. */
export interface InstalledSkillView {
  /** Kebab-case skill name. */
  name: string
  /** Frontmatter description. */
  description: string
  /** SHA-256 tree digest recorded at install time. */
  digest: string
  /** Origin path recorded at install time. */
  origin: string
  /** ISO 8601 install timestamp. */
  installedAt: string
  /**
   * Source of the same-named skill that currently wins over this installed
   * one in the registry's global snapshot, present only when such a skill is
   * live. Installed skills rank lowest, so any same-named runtime, bundled,
   * user, project, or custom skill shadows them. Preset-scoped overrides are
   * not part of the global snapshot.
   */
  shadowedBy?: SkillSource
}

/** Full plugin-and-skill picture for a fresh page load. */
export interface PluginAdminStatusResult {
  /** Whether this host may install or remove profile plugins. */
  mutations: PluginMutations
  /** Every profile plugin with its restart readiness; empty when no profile runtime was provided. */
  plugins: PluginStateEntry[]
  /** Every user-installed skill, with live-catalog shadowing when known. */
  skills: InstalledSkillView[]
  /** The one parked install transaction, when one awaits consent. */
  parked?: ParkedTransactionView
}

/**
 * Install outcome: a parked transaction with its confirm token, a core
 * refusal with the rollback report, or `unsupported` when this host has no
 * plugin-install owner (see {@link PluginMutations}); `unsupported` touches
 * nothing.
 */
export type PluginAdminInstallOutcome =
  | { kind: 'parked'; transactionId: PluginTransactionId; preview: InstallPreview; confirmToken: PluginConfirmToken }
  | { kind: 'refused'; refusal: InstallRefusal; rollback: RollbackReport }
  | { kind: 'unsupported' }

/**
 * Confirm outcome: the flat commit receipt (package name, version, restart
 * readiness) or the refusal with its rollback report.
 */
export type PluginAdminConfirmOutcome =
  | ({ kind: 'committed' } & InstallCommitted)
  | { kind: 'refused'; refusal: InstallRefusal; rollback: RollbackReport }

/**
 * Remove outcome: the core's removal result or refusal, or `unsupported`
 * when this host has no plugin-install owner. A `pnpm` value of `'failed'`
 * means the plugin is deactivated but its packages may remain in node_modules.
 */
export type PluginAdminRemoveOutcome = RemoveOutcome | { kind: 'unsupported' }

/** Skill install outcome, including the host's runtime name-taken refusal. */
export type SkillInstallOutcome =
  | { kind: 'installed'; name: string; path: string; digest: string }
  | { kind: 'refused'; code: 'invalid-skill' | 'name-taken' | 'escaping-symlink'; detail: string; owner?: SkillSource }

/** Skill remove outcome; `not-managed` means the directory lacks the provenance file. */
export type SkillRemoveOutcome =
  | { kind: 'removed' }
  | { kind: 'refused'; code: 'not-installed' | 'not-managed' }
