import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: ['lib/types/main.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    // The shell ships without node_modules; only Electron and Node builtins
    // remain external. The host itself is spawned from the runtime tree.
    deps: {
      neverBundle: ['electron'],
      alwaysBundle: ['@shres-code/shres-code-desktop-host/wire', '@shres-code/shres-code-home-paths'],
    },
  },
  ...(['preload', 'preload-app'] as const).map(name => ({
    // Sandboxed Electron preloads run as CommonJS even though the application package is ESM.
    entry: { [name]: `lib/types/${name}.js` },
    outDir: 'lib',
    format: ['cjs'] as const,
    platform: 'node' as const,
    target: 'es2024' as const,
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: { neverBundle: ['electron'] },
  })),
])
