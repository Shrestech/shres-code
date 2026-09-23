# Agent Note: Agent-seat settings fail loudly at activation

Status: implemented

## Problem

The `agent-seats` plugin registered its settings namespace through an optional asynchronous injection. A malformed stored section could therefore fail the child registration while the parent plugin fiber stayed active. The Host inventory reported `agent-seats` as active, but the settings descriptor was absent and the Teams page could only report that members were unavailable. This hid invalid user configuration and left valid seat bindings inaccessible.

## Decision

`agent-seats` requires the `settings` service and registers `AGENT_SEATS_SETTINGS_NAMESPACE` directly in `apply`, using the composition entry as its base. Registration validates custom members through `assertExtras` before any seat tools mount. A registration failure rejects plugin activation with the namespace and a correction to the settings document. The plugin owns its settings watcher, so valid changes still remount named seats, the generic hire, and the Team roster template. Losing the settings provider withdraws the seat tools and unstarted template members; a replacement provider activates the roster from its own resolved settings.

The settings format stays strict: `extras` is an array of entries with `name`, `persona`, `provider`, `model`, and optional `role`. Map-shaped or incomplete legacy data remains invalid. The [user-settings seam](../architecture/2026-07-28-user-settings-seam.md) keeps boot-time stored-section validation fail-loud; the [named seats note](../feature/2026-08-16-agent-seats.md) owns the roster roles and process-global seat decision.

## Alternatives considered

**Keep optional injection and render an unavailable Teams state.** Rejected: the parent fiber can remain active after the child registration fails, so the UI loses the diagnostic and hides a configuration error behind an apparently healthy plugin.

**Accept or automatically migrate map-shaped extras.** Rejected: prerelease settings reject obsolete on-disk formats, and the stored map does not contain enough information to reconstruct a custom member persona without inventing user data or dropping the member silently.

**Register seats and custom members as separate namespaces.** Rejected: the current settings document and Team page write one roster, and splitting it would broaden the settings model to repair one malformed section.

## Consequences

Valid settings expose the `agent-seats` namespace to the Teams page and preserve the existing seat and roster behavior. An invalid stored section prevents the plugin from activating and names the settings section to repair. Users can preserve valid product-seat bindings by explicitly repairing or removing the malformed `extras` value; the runtime does not rewrite or guess legacy data.
