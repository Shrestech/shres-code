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
    // The host package is spawned by path, never imported at runtime; inlining
    // its wire constants keeps the shell's entry free of an unresolvable
    // subpath import and lets the app payload ship no node_modules.
    deps: { neverBundle: ['electron'], alwaysBundle: ['@shres-code/shres-code-desktop-host/wire'] },
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
