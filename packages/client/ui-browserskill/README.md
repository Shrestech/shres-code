# @shres-code/shres-code-client-ui-browserskill

The BrowserSkill feature settings in the shared Plugins page: the single disclosed install flow over the gesture-gated [`browserSkill` Remote namespace](../../browser/browserskill/src/gateway.ts) — verified provisioning and the owned-browser launch behind one confirmation, provisioning progress and readiness, and open/close/reset/uninstall teardown with an explicit destructive warning when the owned profile and its sign-ins are deleted.

The feature registers through the keyed `settings.plugins.bundle` slot under `@shres-code/shres-code-browser-bundle`; the generic Plugins manager mounts it only while that bundle is selected and active. Every mutation mints a one-shot gesture token bound to the verb and the keepProfile choice before it spends; the UI offers no bypass for any refusal — there is no "continue anyway" and no alternate-endpoint choice, because the host never contacts or evicts a listener it does not own. Unavailable states render before any download: a missing or too-old installed Chrome, or a host without the mounted runtime, each with no install control.

The consent card names every download (source URL, pinned version, SHA-256), the install location, the extension permissions, the periodic update-metadata fetch that continues even with automatic updates off, and that the agent can act in this browser including on any site signed into there. It also states what the gesture proves: the request sequence, not that a person made it. Reset always requires confirmation to delete the owned profile and its sign-ins. Uninstall defaults to keeping the profile; unchecking that choice surfaces the destructive warning before confirmation.

## Model Experience

None, as this browser-only Settings section registers no model-facing tools, prompts, or session events.

#### KV Cache effect

None. The section is presentation-only and writes nothing model-visible.

## Known Limitations and Deferred Work

- The panel controls only the host-owned runtime, not external BrowserSkill daemons or browsers supplied by remote sessions. There is no override for ownership, verification, or endpoint refusals; the host owns recovery.
