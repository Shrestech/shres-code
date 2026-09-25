import { defineConfig } from 'tsdown'

/**
 * The dependency-free name grammar is consumed by offline installers without
 * the registry runtime, so it is emitted as its own entry beside the provider.
 */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/invariant.js', 'lib/types/name.js', 'lib/types/types.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
