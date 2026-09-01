# Agent Note: Shres product chrome (fearless-girl lockup)

Status: implemented

## Problem

The Web sidebar lockup still drew the old DeepSeek whale plus "deepseek" letterforms and a HARNESS plate, the boot gate printed `HARNESS`, and the root README still attributed Shres Code to the previous product owner. Users reading the running app or the repo intro saw the old product owner after the package and document-title rebrand.

The glyphs were path extracts, so the string-rewriting rebrand and `verify-no-legacy-brand` could not see them. The README sentence used that vendor attribution string, which the brand gate did not list.

## Decision

`BrandWordmark` is a fearless-girl-with-shield mark plus live SVG text `SHRES` and a `CODE` plate. `FishLogo` is the same mark, used on the collapsed rail and empty hero. The boot card prints `Shres Code`. App and site favicons, and `website/public/wordmark.svg`, use the same mark.

The root README introduces Shres Code as a plugin-based agent harness and does not attribute the product to DeepSeek. `verify-no-legacy-brand` rejects the previous vendor-attribution string as well as the retired product name. DeepSeek stays a model-provider name.

Lettering stays `<text>` so a later rename is a string change and a misread lockup cannot hide from search.

The compact export stays `FishLogo`. Call sites and CSS locals (`.fish`, `.railFish`) are layout names, not product copy.

## Alternatives considered

**Keep the extracted letterform paths and only drop the whale.** Rejected because those paths still read as "deepseek" and stay invisible to brand gates.

**Rename `FishLogo` to `RooLogo` in the same change.** Deferred: the export is not user-visible, and renaming would churn call sites and snapshots without changing what the user sees.

**Put the illustrated mascot GIF in the sidebar lockup.** Rejected for a 24px currentColor mark; the photos stay under `website/public/mascot/` for marketing surfaces.

## Consequences

The running Web chrome and the root README read as Shres Code. DeepSeek remains a provider name in settings, models, and onboarding. Sidebar DOM snapshots change with the new SVG. The live plugin loader reads `packages/client/ui-primitives/lib`, so `tsc -b` plus `tsdown` on that package (and `pnpm run build:web` for the shell) must run before `shres web` serves the new lockup.
