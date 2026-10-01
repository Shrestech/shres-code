# Agent Note: Published files lists carry tsdown's hashed shared chunks

Status: implemented

## Problem

tsdown bundles each package from the tsc-emitted tree and splits modules shared between entries into hashed chunks such as `lib/config-<hash>.js`. A package gains one whenever a second entry imports a value from a module the first entry also uses. Manifest `files` lists are hand-maintained, and nothing forced a new chunk into either the manifest or the workspace-constraints generator, so `shres-code-judgment-guardrails` and `shres-code-worker-escalation` published without their shared `lib/config-*.js` chunk. The published `./invariant` subpath then could not load, a defect `verify-built-package-invariants` reproduces by staging exactly the declared `files` and running the companion under plain Node.

## Decision

Hashed shared chunks are published through named per-package entries in `packageFileExtras` in `scripts/check-workspace-constraints.ts`, mirrored into that package's `files` list in the same change. The constraints gate fails any manifest that diverges from `expectedShresPackageFiles`, and the built-invariant gate proves the staged companion loads. The convention already carried the jspace and agent-team fold chunks, the research-protocol epoch chunk, and the sandbox-windows-acl types chunk; the two 2026-09-26 entries add `lib/config-*.js` for the settings-namespace chunk shared by each package's entry and invariant companion.

## Alternatives considered

- **Restructure the invariant companions to import no shared value.** Rejected: a source change with no benefit over declaring the chunk; the companions legitimately read the same settings namespace as the entry.
- **Loosen the exact-equality `files` rule or ignore the finding.** Rejected: exact equality is what turns a forgotten chunk into a gate failure instead of a broken publication.

## Consequences

- Adding an entry to a package, or any module both entries import, means checking the build output for new `lib/<name>-<hash>.js` chunks and declaring them in `packageFileExtras` and the manifest together.
- This is the publication-side instance of the rule the [single-file SDK runtime distribution](../architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md) note states for the deploy side: packs run by `files`, so everything the runtime imports must be declared there.
