# @shres-code/shres-code-client-ui-settings-jspace

Browser Settings page for the J-Space host seat. It registers a `settings.section` row (`id: jspace`, order 13, after Shield at 12) and binds the Host `jspace` namespace.

The page leads with an activate/disable switch. It edits `mode` (`available` / `always-open`) and `requireCoverage` immediately. Below the switch it shows the selected session's card as open or closed and the Checked-line count, or last-known values, or an em dash when none exist. Those fields come from the selected session's `jspace` projection, not from the `jspace` settings document.

The same page hosts the LLM Wiki toggle over the `wiki` namespace, with a WikiSkill paper citation. Librarian provider/model pickers render only while wiki is enabled and list every configurable provider from `api.llm.models`. Nothing is bound by default.

The page states the coverage honesty limit: checkpoints name a verifier; the harness cannot prove it ran.

The Host seat (`@shres-code/shres-code-jspace`) owns the namespace and remounts consumers when these fields change. This package never imports the Host package.

## Model Experience

None, as the section renders a browser configuration UI; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Card counts are last-known projection values** — the Settings page is root-scoped and has no snapshot RPC. A missing current session keeps the last view or shows an em dash.
- **Coverage is a term match** — this page states that limit; the Host seat cannot prove the named verifier ran.
- **Wiki librarian is unbound by default** — enabling the wiki mounts tools; librarian dispatch stays dormant until the user picks a provider and model.
