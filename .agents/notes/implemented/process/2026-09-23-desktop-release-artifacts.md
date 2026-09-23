# Agent Note: Desktop installer artifacts and signed releases

Status: implemented

## Problem

A desktop installer needs the complete runtime dependency closure and built frontend. A fresh packaging checkout cannot consume another job's untransferred build output. Copying runtime files after signing invalidates the signature, and uploading a raw application directory through Actions loses executable permissions and framework links. A newly installed desktop also needs its own profile manifest before the host can load it.

## Decision

The desktop workflow builds the runtime and frontend in the packaging job. The desktop scripts pack the first-party dependency closure, including peer-only workspace members, and install it into a separate hoisted runtime. The repository lockfile seeds third-party selections; pnpm rewrites the packed importer before a frozen installation. Package payloads must include their emitted JavaScript chunks and third-party JavaScript entrypoints, including those stored under source directories. Runtime preparation rejects missing members, unsupported build targets, and symlinks rather than recursively dereferencing package-manager stores. The electron-builder `afterPack` hook copies the complete runtime before signing and installer creation.

The Electron shell ships without its own `node_modules`. Its build inlines the home-path helpers and host wire constants; packaging rejects remaining external imports except Electron and Node builtins. Installer verification extracts the ZIP outside the repository so an ancestor workspace dependency cannot conceal a missing package.

The private shell and host share the Shres version but are excluded from npm publication. CI publishes macOS ARM64 DMG/ZIP files with checksums as expiring Actions artifacts. Public GitHub Releases require an explicit workflow dispatch from a version-matched `shres-v*` tag and a separate signing environment. Release mode requires Developer ID credentials, hardened runtime, notarization, signature verification, and the packaged runtime smoke. The ad-hoc development path cannot become a public release by omitting credentials. The release job publishes the verified installer bytes without rebuilding them.

The shell creates a missing desktop profile with exclusive file creation at `$SHRES_HOME/profiles/desktop`; an existing manifest is never overwritten, and the host loader remains its validator. Packaged profiles are separate from the runtime's `node_modules`, so the executable host entrypoint anchors `healProfilesModuleFallback` to the installed desktop-host manifest as authoritative dependency metadata and links that closure under `$SHRES_HOME/profiles/node_modules` before profile loading; exported `runDesktopHost` remains explicit and does not mutate that home fallback. The smoke uses that initializer, the packaged executable, a disposable home, and real request pipes, reads the boot graph, and fetches the module-loader, client-runtime, and layout bundle URLs before proving the runtime can serve its UI. The [host-process design](../architecture/2026-09-17-desktop-host-child-process.md) and [explicit-directory profile loader](../architecture/2026-09-17-desktop-port-staged-resolution.md) retain their ownership; signing does not require introducing ASAR profile resolution.

## Alternatives considered

**Upload the raw `.app` directory.** Actions archives normalize file permissions; an inner ZIP preserves the application's native filesystem metadata for downloads.

**Copy dependencies after signing.** The runtime belongs to the signed bundle. Injecting it in `afterPack` lets electron-builder sign and notarize the complete payload before creating either installer.

**Publish ad-hoc builds when credentials are absent.** That would make the public-download path depend silently on repository secret configuration. Missing signing credentials are a release error; ad-hoc builds remain available as CI artifacts.

**Add the ASAR profile-resolution machinery with signing.** The installed runtime uses ordinary filesystem paths and the existing explicit-directory loader. ASAR would introduce an independent runtime-resolution change without helping the installer or signing sequence.

## Consequences

Packaging includes a full build and dependency installation, increasing CI time. The build check exercises a fresh profile and packaged resources without model credentials. Signing and Apple's notarization service remain external prerequisites, so local ad-hoc success does not establish public-release success. Release setup and commands live in the [desktop README](../../../../apps/desktop/README.md). Automatic updates and other operating-system targets remain outside this pipeline.
