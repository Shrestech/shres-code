# @shres-code/shres-code-client-ui-settings-general

Global navigation, searchable settings pages, and durable product onboarding. The package occupies `shell.navigation` with Workspace, Teams, Plugins, Customize, and Settings destinations. Teams owns the team roster; Plugins contains the shared bundle manager and feature-owned bundle details; Customize contains agent presets; Settings contains preferences and other feature-owned configuration sections. Section contributions remain in the `settings.section` ledger, and unknown section ids appear under Settings. The frame keeps the workspace mounted and inert while a destination page is open, preserving drafts and session inspection state. Escape or Workspace returns to the workspace.

While the frame's `ctx.layout` exists, the shell provides `ctx.settingsPages` ([contract](../ui-settings/README.md)): `open(sectionId)` checks the id against the `settings.section` entries it declared and then calls `ctx.layout.navigate(sectionId)`. A call made before `settings.section` is declared is released when the declaration commits and resumes after the declaring `register()` call returned, so sections that register inside that call are on the ledger; waiting and later calls reject once the face is withdrawn (plugin unload or HMR). A section's owner share carries only `close`; links between sections use the face. When another plugin changes the destination, SettingsRoot does what its own links do: opening Settings records the focused control for the return on close and clears the nav filter, and a filter that would hide the shown section is cleared.

Preferences groups feature-owned `settings.general.item` rows into session defaults, interaction, appearance, and an additional group for other contributions. Appearance also has a direct navigation entry targeting the same preference row. Search filters the current destination's navigation; Cmd/Ctrl+K focuses it. The shell owns navigation and copy, while feature packages own preference values and writes.

The shell ships no onboarding copy of its own — all text arrives from registrants. Nav labels may be locale-following thunks, so the nav projection resolves them through `resolveSlotLabel` and re-renders on the section ledger bump or the locale revision. The onboarding ledger projects in ascending order and mounts exactly one step at a time. Visible steps own their dialog chrome and app-root `inert` lifecycle; a mounted step still resolving private facts renders null, so nothing paints or blocks while it decides. The active registrant receives its id, `complete()`, and an `openSection(id)` callback; completing or skipping transfers ownership to the next entry. Registrants own durable completion, capability readiness, copy, mutations, and their visible wrapper, so independently registered flows cannot stack and the shell does not become a second configuration fact source.

A loopback browser loads the provider's `hasDocument` capability through `settings.describe` and renders **Open configuration file** only when the Host confirms that a provider-owned local document can be prepared. The action sends the pathless, loopback-only `settings.openDocument` request; the Host resolves the provider path again, materializes an absent document, and hands it to a native text editor (`open -t` on macOS, bypassing a browser file association; the desktop file association on Linux and Windows; Windows association after `wslpath -w` translation on WSL). Open failures keep the action available and render a localized error. Reopening Settings or reconnecting refreshes availability after a transient read failure or Host topology change. Remote browsers never register the action and never issue the privileged settings read.

The Host half registers `ui-onboarding` in the user-settings seam. The welcome step contributed by `ui-settings-models` reads and writes its `welcomeNoticeVersion` through the existing public settings boundary; the shell itself remains policy-free.

## Model Experience

None, as the plugin renders browser settings UI; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- The General section has no built-in rows; each row appears only when its owning feature plugin is mounted.
