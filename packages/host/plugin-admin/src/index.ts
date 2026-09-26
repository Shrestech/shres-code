/**
 * pluginAdmin entry: the gesture-gated Remote gateway over the shared
 * plugin and skill install core, mounted only through its composition row.
 * @module @shres-code/shres-code-host-plugin-admin
 */

import PluginAdminGateway from './gateway.ts'

// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'

export { PluginAdminGateway, Config } from './gateway.ts'
export type { PluginAdminConfig } from './gateway.ts'
export default PluginAdminGateway
export { PluginAdminError } from './errors.ts'
export type { PluginAdminErrorCode } from './errors.ts'
export type {
  InstalledSkillView,
  ParkedTransactionView,
  PluginAdminBeginRequest,
  PluginAdminConfirmOutcome,
  PluginAdminGestureVerb,
  PluginAdminInstallOutcome,
  PluginAdminInstallRequest,
  PluginAdminRemoveOutcome,
  PluginAdminRemoveRequest,
  PluginAdminSettleRequest,
  PluginAdminSkillAddRequest,
  PluginAdminSkillRemoveRequest,
  PluginAdminStatusResult,
  PluginConfirmToken,
  PluginGestureGrant,
  PluginGestureToken,
  PluginMutations,
  PluginTransactionId,
  SkillInstallOutcome,
  SkillRemoveOutcome,
} from './types.ts'
export type {
  InstallCommitted,
  InstallPreview,
  InstallRefusal,
  PluginStateEntry,
  RollbackReport,
} from './types.ts'
