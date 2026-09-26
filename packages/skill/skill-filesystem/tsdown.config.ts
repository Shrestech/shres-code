import { defineConfig } from 'tsdown'

/**
 * The install subpath is consumed before (and without) a booted context, so
 * it is emitted beside the provider entry instead of bundled into it.
 */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/install.js', 'lib/types/invariant.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
