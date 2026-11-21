# Bump the pinned BrowserSkill release

The managed runtime runs the release [manifest.ts](../../packages/browser/browserskill/src/runtime/manifest.ts) pins, never `releases/latest`. This procedure is how a new upstream release becomes that pin. It changes a security invariant, so every value is measured from the release bytes rather than read from a page.

## 1. Find the release pair

Upstream publishes the CLI under `cli-v<version>` and the extension under `ext-v<version>`, usually minutes apart. They are one atomic upgrade unit: 0.4.1 moved both peers to a negotiated protocol version, so a mixed pair is refused at launch. Take the newest pair that has both tags and note both versions.

## 2. Measure the artifacts

Download, in a scratch directory, the darwin-arm64 CLI archive `bsk-v<version>-aarch64-apple-darwin.tar.gz` and the extension zip `browser-skill-extension-v<version>-chrome.zip`. Record, without executing either artifact:

1. The archive's SHA-256 and byte size, and confirm the hash matches the `assets` entry for `darwin-arm64` in `https://github.com/Tencent/BrowserSkill/releases/latest/download/version.json`.
2. The extracted `bsk` binary's SHA-256 and byte size.
3. The extension zip's SHA-256 and byte size, and its unpacked tree digest: every regular file's POSIX-relative path, a NUL, the file's SHA-256 and a newline, records sorted by the path's UTF-8 bytes.
4. The unpacked extension's `manifest.json`: `version`, `minimum_chrome_version`, and the `permissions` and `host_permissions` arrays.
5. The extension's stored keys and default daemon endpoint, which live in its compiled background worker.

## 3. Re-measure the wire surface

Run the new CLI once in a disposable `BSK_HOME` with the runtime's own environment (`BSK_AUTO_START=0`, `BSK_AUTO_UPDATE=off`) and confirm each reply shape the runtime parses: `status --json` (`daemon_version`, `pid`, `ws_port`), `browsers --json` (`instance_id`, `label`), `session start/stop`, `navigate`, `observe`, `click --ref`, `fill --value=`, `press`, and `daemon start --foreground --port`. Then pair the owned Chrome profile once and confirm readiness still verifies the instance id read from extension storage.

A changed reply name or a newly required flag is not a pin bump; it expands into runner and argv work and deserves its own change.

## 4. Record and change

1. Write the measurements into `scripts/browserskill-pin-evidence.json` for the new version pair.
2. Update `BSK_VERSION`, `EXTENSION_VERSION`, the derived asset names and URLs, `BSK_PLATFORM_PIN`, `EXTENSION_ASSET`, `EXTENSION_TREE_SHA256`, and `EXTENSION_PERMISSIONS` in `manifest.ts`. Leave `CHROME_MINIMUM_MAJOR`, the daemon port, the owned label, the storage keys and both patterns alone unless a measurement disproves them.
3. If the extension's permission set changed, say so in the Agent Note and the consent copy; an update that adds a permission re-takes consent.
4. Update the pinned-version assertions in the package's manifest spec, the fixture URLs in its provisioning spec, and the fake daemon's reported version.
5. Run the package suite, `pnpm run verify-type-equiv`, and `pnpm run doc-sync`. Then pair the browser once through **Plugins → BrowserSkill** on macOS arm64 to re-prove the consent, provisioning, pairing and tool path end to end.

## 5. Ship and check

`pnpm run check:browserskill-pins` verifies the pins against the recorded evidence offline; its `--remote` mode prints how far behind upstream the pins are and never fails a build.
