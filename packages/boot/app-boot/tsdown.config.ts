import { defineConfig } from 'tsdown'

/**
 * Embed Include while keeping Loader external so the built include tree and
 * app host bind to one Loader peer.
 */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/invariant.js', 'lib/types/profile-plugin-types.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: {
    alwaysBundle: ['@shres-code/cordis-plugin-include'],
  },
})
