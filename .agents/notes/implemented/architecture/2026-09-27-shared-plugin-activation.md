# Agent Note: Shared plugin activation and feature-owned setup

Status: implemented

## Problem

A feature's runtime setup does not install or enable its Cordis plugin. Presenting BrowserSkill provisioning as a standalone Settings installer obscures that distinction and gives no shared way to stop its tools, guide, and browser controls together. Independently disabling its host row can leave a client page whose Remote proxy exists while its receiver does not.

## Decision

The shared [plugin administration gateway](../../../../packages/host/plugin-admin/README.md) owns profile bundle selection and addressable plugin-row enablement alongside the existing transactional installer. The [Plugins UI](../../../../packages/client/ui-settings-plugin-inventory/README.md) lists available bundles and current Loader state, reports persistence and live application separately, and renders feature-owned configuration through a keyed slot. Generic management imports no BrowserSkill component and contains no feature-specific lifecycle logic.

[BrowserSkill](../../../../packages/bundle/browser/README.md) is an optional shipped bundle that composes its host and client rows together. Its controls live under the bundle's details in Plugins. Enabling the bundle mounts the tools and guide; setting up runtime assets remains a separate consented action. Disabling it disposes its plugin effects without deleting retained runtime data. Removing runtime data remains an explicit BrowserSkill action. Existing profile manifests are not silently enrolled in the optional bundle.

Client bundle activation uses the client module graph as the browser counterpart of profile composition. The host publishes graph changes only after Loader work settles; the browser HMR driver serializes graph and rebuilt frames, reconciles rows through the Loader, retries missing or failed entries on a repeated graph frame, and leaves fibers pending when they are waiting for declared services. Obsolete rows withdraw their factories and styles after disposal. Self-reload drains the old HMR fiber and opens a fresh event stream only while the owning Loader tree remains live, and self-removal waits until unrelated rows finish reconciling.

All profile mutations use the same profile lease and recovery owner as package installation. New activation calls retain the loopback restriction and one-use, verb-and-target-bound gestures. The manager refuses changes to its own required infrastructure and to rows a profile override cannot address unambiguously. Bundle selection compares protected rows and their enclosing group options in the full composition, so an override-only bundle cannot disable the manager indirectly. Higher-priority home and command-line patches keep their precedence; a saved preference is not evidence that its effective value changed.

The [managed installation note](../feature/2026-09-24-managed-plugin-and-skill-installation.md) owns package staging, scripts refusal, parked consent, and rollback. The [BrowserSkill runtime note](../feature/2026-09-25-ui-browserskill-installation.md) owns native consent, pinned assets, command drainage, and verified process teardown. The [Plugins tab note](2026-08-11-plugin-settings-tabs.md) owns feature contribution and slot withdrawal. Those decisions retain independent value; this note supersedes their standalone setup navigation and fixed bundle-activation assumptions only.

## Alternatives considered

**Only move the BrowserSkill page.** Navigation alone leaves it permanently composed and continues to conflate runtime provisioning with plugin lifecycle. A selectable bundle makes the host and client ownership explicit.

**Copy the upstream manager and keep a second installer.** Two owners for profile locks, package consent, and restoration would permit inconsistent outcomes. Shres reuses its transactional installer and adopts the shared management and feature contribution pattern.

**Make runtime removal disable the plugin.** Asset removal and plugin activation have different consent, failure, and retention semantics. Keeping them separate permits disabling and re-enabling without deleting an owned browser profile or downloading assets again.

**Expose unrestricted Loader toggles.** Disabling the manager or its transport can remove the only UI able to reverse the change. Nested or ambiguous identities can also target a different row through a profile patch. Explicit restrictions preserve a reachable management path.

## Consequences

The manager can change a plugin's active tools and therefore the next model request's tool schemas. It adds no model call or prompt of its own. Existing session logging remains responsible for reconstructing model-visible requests. A feature with an unavailable host must display that state without offering runtime setup actions against an absent receiver.

Optional BrowserSkill activation is a user choice. The shipped package remains on disk when deselected, and its private runtime data remains until the user requests removal. General package installation keeps its existing script and platform restrictions. Live application failures and higher-priority overrides must remain visible rather than being reported as successful activation.
