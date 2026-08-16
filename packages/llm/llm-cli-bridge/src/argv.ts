/**
 * Per-route argv construction: binary, extra flags, model, effort, prompt.
 * @module @roos-code/roos-code-llm-cli-bridge/argv
 */

import { assertNever, LlmError } from '@roos-code/roos-code-llm'
import type { CliBridgeRoute } from './config.ts'

/** Inputs that become CLI flags for one delegated completion. */
export interface CliArgvRequest {
  /** Exact model id from {@link import('@roos-code/roos-code-llm').GenerateOptions.model}. */
  model: string
  /** Exact effort id, when the caller or resolver supplied one. */
  effort?: string
  /** Serialized conversation prompt. */
  prompt: string
}

/**
 * Build the argv for one route. Model and effort are always forwarded when
 * present; an effort the route does not advertise throws `UNSUPPORTED_OPTION`.
 * @param route - resolved per-route flag map.
 * @param request - model, optional effort, and prompt.
 * @returns argv starting with {@link CliBridgeRoute.binary}.
 */
export function buildCliArgv(route: CliBridgeRoute, request: CliArgvRequest): string[] {
  const argv: string[] = [route.binary, ...route.extraArgs]
  if (request.model.length === 0) {
    throw new LlmError('llm-cli-bridge: model must be a non-empty string', 'UNSUPPORTED_OPTION')
  }
  argv.push(route.modelArg, request.model)
  if (request.effort !== undefined) {
    argv.push(...effortFlags(route, request.effort))
  }
  if (route.promptStyle === 'flag') {
    const promptArg = route.promptArg
    if (promptArg === undefined) {
      throw new LlmError('llm-cli-bridge: promptStyle "flag" requires promptArg', 'UNSUPPORTED_OPTION')
    }
    argv.push(promptArg, request.prompt)
  } else {
    argv.push(request.prompt)
  }
  return argv
}

/**
 * Map one advertised effort onto this CLI's flag dialect.
 * @param route - resolved route.
 * @param effort - exact advertised id.
 * @returns argv fragments (possibly empty for a no-op style).
 */
export function effortFlags(route: CliBridgeRoute, effort: string): string[] {
  if (!route.efforts.includes(effort)) {
    throw new LlmError(
      `llm-cli-bridge: route does not support reasoning effort "${effort}"`,
      'UNSUPPORTED_OPTION',
    )
  }
  switch (route.effortStyle) {
    case 'flag': {
      const flag = route.effortArg
      if (flag === undefined) {
        throw new LlmError('llm-cli-bridge: effortStyle "flag" requires effortArg', 'UNSUPPORTED_OPTION')
      }
      return [flag, effort]
    }
    case 'thinking-bool':
      return [effort === 'off' ? '--no-thinking' : '--thinking']
    case 'codex-config': {
      const key = route.effortArg ?? 'model_reasoning_effort'
      return ['-c', `${key}=${effort}`]
    }
    default:
      return assertNever(route.effortStyle)
  }
}
