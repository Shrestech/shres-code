import { defineConfig } from 'tsdown'

/**
 * The desktop host ships one entry: the child process the Electron main
 * process spawns. Declarations come from `tsc -b` (dts: false), matching every
 * package.
 */
export default defineConfig({
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
