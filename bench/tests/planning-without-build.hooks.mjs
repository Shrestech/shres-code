/**
 * Resolve any package lib module as missing so a dry-run CLI spawn cannot
 * accidentally load a built face.
 */
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL ?? ''
    const haystack = specifier + '\n' + parent
    if (/packages\/[^/]+\/[^/]+\/lib(?:\/|$)/.test(specifier) || /\/packages\/[^/]+\/[^/]+\/lib(?:\/|$)/.test(haystack)) {
      const error = new Error("Cannot find module '" + specifier + "'")
      error.code = 'ERR_MODULE_NOT_FOUND'
      throw error
    }
    return nextResolve(specifier, context)
  },
})
