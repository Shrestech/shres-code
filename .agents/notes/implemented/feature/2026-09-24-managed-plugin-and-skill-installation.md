# Agent Note: Managed profile plugins and installed skills

Status: implemented

## Problem

A package-manager command can fetch a dependency without making it a valid profile bundle, obtaining activation consent, or preserving recoverable profile metadata. A copied skill has different consequences: its instructions can enter a model request without executing a plugin, but it may depend on external programs that are not installed with those instructions. CLI and Web entry points need the same lifecycle decisions without presenting these two operations as equivalent.

## Decision

The [app-boot core](../../../../packages/boot/app-boot/README.md#profiles) owns managed plugin transactions. CLI adapters and the [pluginAdmin host gateway](../../../../packages/host/plugin-admin/README.md) share it. One profile lease spans recovery, dependency changes, parked consent, composition validation, and settlement. The raw CLI wrapper retains that lease through its expert operation. The lock coordinates participating writers; it cannot serialize unrelated processes that ignore it.

Install writes a recovery journal before mutation and runs pnpm without lifecycle scripts or pnpmfile hooks. Package metadata and bundle composition are inspected without importing package JavaScript or evaluating configuration expressions. Confirmation changes the active bundle list; execution waits for a profile restart. Removal deactivates before dependency cleanup, and recovery never reactivates a removed bundle. Restoration preserves original UTF-8 manifest and lockfile text; offline dependency repair is best effort, not an atomic restoration of package directories or native builds.

Local-directory installs use a profile-owned UUID source snapshot. Direct `file:` dependencies are insufficient isolation because pnpm can hardlink their files. Keeping the snapshot after commit also gives later reinstalls a stable source. Copying rejects retained symlinks and special files, excludes checkout and dependency directories, and validates nested local dependencies against the copied tree. Successful managed removal deletes the owned snapshot; failed or raw cleanup can leave inert copies. There is no content-addressed cache or reuse policy.

The launcher publishes immutable profile metadata and an explicit plugin-mutation capability. CLI and profile-backed Web hosts enable mutation; Desktop hosts and Web hosts without that metadata do not. Skill installation remains independent. Host gesture and confirmation tokens bind targets and prevent replay; they do not prove human presence or prevent a same-user process from making localhost requests. The privileged namespace remains unavailable through remote connections.

Installed skills live under the Harness home, outside ordinary project and user-authored skill directories. The [filesystem provider](../../../../packages/skill/skill-filesystem/README.md) assigns them the lowest default precedence and returns their content as untrusted. Staging outside the watched root prevents incomplete copies from becoming discoverable. Provenance and digests describe the copied content; they are not an endorsement. Publication and removal use the existing registry invalidation and durable skill-tool output paths.

[BrowserSkill setup](../../../../docs/cookbook/browserskill.md) uses this skill mechanism with a separately provisioned `bsk` runtime. Its DeepSeek Harness package is not treated as a native Shres bundle. The setup path neither installs a browser extension nor connects a browser profile automatically.

## Alternatives considered

**Forward every install directly to pnpm.** This leaves bundle validation, consent, activation, and recovery to callers and permits the CLI and Web implementations to disagree. Raw forwarding remains an explicit expert path, not the managed installer.

**Install local directories directly with `file:` or `link:`.** Both retain a dependency on the original source. Hardlinked files can change when the source is edited, and subsequent installs can recopy changed content. A retained UUID snapshot provides isolation without inventing cache ownership and eviction.

**Run package scripts to accommodate more plugins.** That executes fetched code before activation consent and makes rollback claims weaker. Packages that require builds are refused instead.

**Match build requirements by added package names.** Multiple installed versions and local, tarball, or git references do not have interchangeable identifiers. Name-only matching refuses unchanged native dependencies. The installer compares the full contents of build-declaring package trees before and after pnpm, including prior build outputs; manifest-only fingerprints miss replacements that retain their scripts but change source files. These ephemeral digests do not name or cache the retained source snapshots.

**Hot-mount plugin packages after confirmation.** Dependency installation does not establish that a live host and browser can safely replace their module graphs. Restart-required readiness keeps activation tied to profile composition.

**Port BrowserSkill’s native DeepSeek Harness integration.** That is a separate API and UI adaptation, not installation of a compatible bundle. The external CLI route exercises skill loading and command execution without claiming native-plugin compatibility.

## Consequences

Managed installation is narrower than pnpm: existing direct dependency replacement, incompatible bundles, live-link dependencies, and required builds are refused. Windows plugin mutation is unsupported, while raw commands and skill operations retain their existing platform behavior. The consent interval holds the profile lease, so another participating writer must wait or report contention. A cancelled or interrupted operation can require a later recovery attempt.

Real offline pnpm tests pin independent local bytes after source edits and reinstall, script suppression, fresh-home composition, and snapshot cleanup through profile aliases. A source-CLI smoke exercises first-profile installation and removal without an ancestor workspace dependency fallback. Keyless examples exercise installed instructions through the real Loader and tools; an external-CLI stub does not verify BrowserSkill’s daemon or extension. Real browser readiness requires explicit runtime provisioning, diagnostics in the bash tool’s environment, and a limited task with session cleanup.

The [skill registry decision](2026-07-05-skill-system.md), [catalog refresh decision](2026-07-27-skill-catalog-hot-refresh.md), and [personal configuration decision](2026-07-20-cli-personal-config.md) remain active: they own provider layering, catalog invalidation, and patch precedence independently of installation.
