/**
 * Shared browser platform modules. Seeding, bundling externals, and Vite
 * aliases consume this list so their module identities cannot drift.
 * @module @shres-code/shres-code-client-web/src/platform
 */

/** The module specifiers the shell shares into the frozen module table. */
export const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@shres-code/cordis',
  '@shres-code/shres-code-client-ui-slots',
  '@shres-code/shres-code-client-web-react',
  '@shres-code/shres-code-client-ui-primitives',
  '@shres-code/shres-code-client-ui-attachment',
  '@shres-code/shres-code-client-schema-form',
] as const

/** One platform module specifier (a seed-table key). */
export type PlatformModule = (typeof PLATFORM_MODULES)[number]
