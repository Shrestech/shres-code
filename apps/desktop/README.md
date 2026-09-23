# Shres Code desktop

The Electron application bundles the shared web UI and a private [desktop host](../desktop-host/README.md). Both desktop packages share the Shres version and remain outside npm publication. The app serves requests over `shres-app://` and child-process pipes; a separate web server is unnecessary. The shell creates a missing desktop profile under `$SHRES_HOME/profiles/desktop` and preserves existing configuration.

## Build and verify

Use an Apple Silicon Mac and the repository's supported Node and pnpm versions. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm --filter @shres-code/shres-code-desktop run package
pnpm --filter @shres-code/shres-code-desktop run smoke
```

`package` builds the shell, packs and installs the runtime dependency closure, and creates a DMG and ZIP under `apps/desktop/.desktop-build/targets/mac-arm64/artifacts`. `package:dir` produces only the `.app`. Both require the full runtime and web build above. The runtime enters the app before signing; installers contain those signed bytes. Local builds use ad-hoc signing and do not pass Apple's public-distribution checks.

The smoke check uses the app's own Electron executable in Node mode to execute the bundled terminal helper and boot a disposable profile at `$SHRES_HOME/profiles/desktop`. It reads the injected boot graph, fetches the boot-graph URLs for the module loader, client runtime, and layout bundles, creates a scratch workspace over the production transport, observes its event, and checks shutdown. The host entrypoint heals the installed dependency fallback under `$SHRES_HOME/profiles/node_modules` from the desktop-host manifest before it loads the profile. CI repeats the smoke against the app extracted from the ZIP. `pnpm run dev:desktop` builds and launches from workspace sources; `pnpm run start:desktop` launches existing development outputs.

## CI artifacts and releases

The [desktop workflow](../../.github/workflows/desktop.yml) builds and checks pull requests and pushes to `master` and `develop`. Download the `shres-code-mac-arm64` artifact from its Actions run. It contains DMG/ZIP files and SHA-256 checksums, retained for seven days. Archiving the application inside the ZIP preserves executable permissions and Electron framework links across artifact download.

Public releases require a `desktop-release` GitHub environment with these secrets:

| Secret | Value |
| --- | --- |
| `CSC_LINK` | Base64-encoded Developer ID Application certificate in `.p12` format |
| `CSC_KEY_PASSWORD` | Certificate export password |
| `APPLE_ID` | Apple developer account email |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for notarization |
| `APPLE_TEAM_ID` | Apple Developer team ID |

Restrict that environment to release tags and configure its reviewers in repository settings. Create a `shres-v<version>` tag matching the desktop manifest on a commit in `master`, then run the desktop workflow from that tag with `publish` enabled. The release job requires these credentials, signs with hardened runtime, notarizes, verifies the app, runs the smoke check, and publishes the DMG/ZIP/checksums to GitHub Releases. Prerelease versions remain marked as prereleases. Missing credentials or failed validation stop publication. PR artifact jobs receive no signing credentials.

Signing configuration follows [electron-builder v26](https://www.electron.build/v26/docs/mac/); `SHRES_DESKTOP_RELEASE=1` enables the same mandatory signing and notarization checks locally. The [packaging decision](../../.agents/notes/implemented/process/2026-09-23-desktop-release-artifacts.md) records dependency and publication ownership.

## Known limitations

The distribution target is macOS ARM64. Windows, Intel Mac, Linux, and automatic application updates are not configured. Public signing and notarization require an Apple Developer membership and the secrets above; ad-hoc CI artifacts are for development use.
