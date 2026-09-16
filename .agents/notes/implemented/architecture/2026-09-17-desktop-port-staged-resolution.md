# Agent Note: Desktop port stages profile resolution

Status: implemented

## Problem

The Electron desktop port (branch `feat/desktop-app`, from DeepSeek Harness `apps/desktop` + `apps/desktop-host`) boots an installed shres project from a directory the shell owns, placed outside `$SHRES_HOME/profiles` (the dev project under `.desktop-build/development/project`). `loadProfile` resolves a profile by name under the Harness home, auto-initializes shipped templates on first use, and normalizes installation-owned bundle tuples — a second owner for a directory the shell creates. Upstream's alternative is a `profileResolution` generation API plus a `PluginPackages` service (~2.1k LOC) whose only consumer is the packaged ASAR runtime mode, which has no consumer in this tree in Stage A.

## Decision

Profile loading grows an explicit-directory entry point instead of the generation API: `loadProfileDirectory(binName, dir, installAnchor, options)` loads a manifest from any directory with the same two-anchor bundle resolution and `shres.bundle.patch` validation as `loadProfile`, without template auto-initialization or name-keyed normalization; the loaded name is the directory basename. Both loaders share one private `resolveProfile` body, so the user-layer rule (`userLayer: false` skips a broken `cordis.patch.yml`) stays symmetric. Stage A of the desktop port (link-mode dev, unsigned unpackaged artifacts) runs on this loader. The upstream `profile-resolution/` machinery (generation API, `PluginPackages`, ESM default-resolver binding, ASAR support) is Stage B: back-ported as an isolated module beside `profile.ts` — which keeps owning templates, editions, and Shield — when the desktop moves to ASAR packaging with signing.

## Alternatives considered

**Back-port the upstream profile-resolution machinery first.** Rejected: upstream `app-boot` carries 109 commits of divergence and the machinery has no consumer until the packaged mode exists; merging it first maximizes conflict surface for zero user-visible gain.

**Place the desktop's project under `profiles/` and keep `loadProfile`.** Rejected: the shell owns that directory's lifecycle; parking it in the named-profile store couples two owners and makes the dev project visible to every profile-listing surface.

**Keep an unpackaged desktop forever (adapt-only).** Rejected: permanently forks the ASAR integrity, signed runtime tree, and runtime-resolution design upstream carries, and guarantees a harder migration later.

## Consequences

`loadProfile` behavior is unchanged; shared-shape specs cover both loaders (ordered layers, fail-loud manifest and bundle-less errors, user-layer skip, no normalization for a directory named like a shipped template). Stage A packaging deviations (asar off, bundled-node pnpm, no `PluginPackages`) live at the desktop port's packaging seam and converge in Stage B. A change that renames or moves the explicit-directory contract updates this note.
