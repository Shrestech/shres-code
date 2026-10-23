# Agent Note: Packed-consumer verification restores and exercises prebuilt native binaries

Status: implemented

## Problem

The packed-consumer verification in [verify-packed-install.ts](../../../../scripts/release/verify-packed-install.ts) installed the tarballs with `--omit=optional`, so that the Landlock platform packages — which need a musl toolchain per architecture — never reach the throwaway tree. koffi distributes its prebuilt binaries as optional `@koromix/koffi-<platform>-<arch>` packages, so the same flag also left the installed koffi with nothing to load: koffi's install script fell back to compiling the addon from source, and on the ubuntu-24.04 runner that compile fails, which failed the "Pack npm tarballs" job after the tarballs were built.

A plain `npm install --omit=optional` does not merely leave koffi unbuilt. npm runs the dependency's install script during that command, the script rebuilds from source and fails, and npm rolls the tree back, deleting `node_modules/koffi`; installing the platform package in a later step therefore has no tree to repair.

The verification's only post-condition was `--version` on the installed executable, which never imports koffi: the harness packages load it on first native use, so a tree whose native module was missing, or built for another architecture, passed. The omission makes that silent by design — `--omit=optional` removes the platform package, and the install scripts that would otherwise build a replacement are exactly the step the omission defers — so the check has to load the module itself.

## Decision

The verification installs the consumer tree in three npm runs. The first places the tree with `--omit=optional --ignore-scripts`, so no package builds while the prebuilt binary packages are still absent. `restorePrebuiltBinaries` then reads the manifest of the dependency npm just installed, picks the `optionalDependencies` entry whose name ends with the host key (`process.platform`-`process.arch`), installs exactly that package at the version the manifest declares, and installs nothing when the tree does not carry the dependency. The third run is `npm rebuild --dangerously-allow-all-scripts`.

The rebuild grants script execution explicitly instead of leaving it to npm's default script policy. The scripts belong to third-party registry dependencies pulled while the ranges resolve, not to the payloads this repository publishes, and the earlier single `npm install` ran every one of them without asking, so this is not a new exposure; on npm releases that gate dependency scripts, unreviewed scripts still run behind an advisory warning. It does override a hardening policy an operator may have configured (deny entries or `strict-allow-scripts`), which is what the `dangerously-` prefix concedes on a throwaway tree built once and deleted. npm also warns that unknown options stop working in a future major, so a runner whose npm predates this flag fails then, not now. With the prebuilt package in place koffi's install script exits 0; without it the script compiles and fails, so that branch reports loudly instead of depending on which policy branch npm took.

Every install keeps `--omit=optional`, so the Landlock platform packages stay out of the tree, and the repair install carries the same flags as the placement install. The script names one dependency, koffi, whose prebuilt binary arrives as an optional package; it carries no koffi version and no platform table, because the package name and version come from the manifest npm installed. A declared version that is not exact (a range, tag, or wildcard) is rejected, since a newer platform build against an older dependency is the mismatch this mechanism prevents. A dependency the tree does carry that declares no package for the host fails the job with `installed <dependency> declares no prebuilt binary package for <host key>`, and a dependency installed only below another package fails with the path it was found at, because its version cannot be read from the top level.

`loadPrebuiltBinaries` then imports each carried dependency in a child process (`node --input-type=module -e "await import('<dependency>')"`) and fails the job on any error. koffi's entry evaluates its static and dynamic native loads and then `wrapNative` while the module evaluates, so the import loads `@koromix/koffi-<platform>` and throws `Cannot find the native Koffi module` when it is absent; `wrapNative` also throws `Mismatched native Koffi modules`, which catches a platform package published at another version — the mismatch the exact-version rule rejects from the other side. A listed dependency has to load its native module at import time for this check to mean anything, and the constant that lists them states that requirement. The child runs with the environment `consumerEnvironment` builds, whose removal of `NODE_PATH` and `NODE_OPTIONS` is load-bearing here: an inherited module path would let it resolve packages from the checkout instead of the installed tree.

Coverage lives in [verify-packed-install.spec.ts](../../../../scripts/release/verify-packed-install.spec.ts), which injects the npm and node invocations and drives selection, exact-version rejection, the absent and nested dependency cases, the load check, and the placement-repair-rebuild-load order against real temporary trees. The [npm release sequences](2026-08-10-npm-release-sequences.md) note owns which families are packed and published; this note owns how the packed consumer is installed and exercised.

## Alternatives considered

**Install the platform package after a plain `npm install --omit=optional`.** Rejected because that install fails and rolls the tree back, so a follow-up step finds no koffi manifest to read.

**Pin the dependency's range in the package manifests.** Rejected: the consumer resolves the manifests' `^3.1.2` from the registry and installs 3.3.3 while the workspace lockfile pins 3.1.2, and both releases distribute prebuilt binaries as optional platform packages, so a tighter range changes what the verification proves without removing the source-build fallback.

**Drop `--omit=optional`.** Rejected: it pulls in the Landlock platform packages, which need a musl toolchain and one build per architecture, and the verification exists to prove the tree a consumer can install.

**Hardcode a platform table or a koffi version.** Rejected: the manifest npm installed already names the platform packages and their exact versions, and a table or a pinned version would drift from each koffi release.

**Accept `npm rebuild`'s exit status as the proof that the native module works.** Rejected because that status reports the build: with the platform package in place koffi's script exits 0 as soon as it notices it, so a binary for another architecture, or a platform package at another version, still passes the build and fails on use. The check has to load the module.

**Allow the scripts by name (`--allow-scripts koffi --strict-allow-scripts`).** Rejected because strict mode fails the job for any other registry dependency that legitimately needs a build while its range resolves, which turns a gate that needs parity with the earlier single install into a per-dependency allowlist to maintain.

**Pass `--foreground-scripts` instead of allowing scripts.** Rejected because it changes where script output goes, not whether npm runs the script; a failing script already reaches the job log through npm's error output.

**Import the restored platform package directly instead of the dependency.** Rejected because the dependency's own import is the path a consumer exercises: it resolves the platform package, loads it, and compares their versions.

## Consequences

The verification performs three npm runs instead of one — one more resolution pass and one rebuild over a tree that is already installed — plus one child Node process per carried prebuilt dependency for the load check. Build scripts run once, after the prebuilt binary package is in place, which is the condition that keeps koffi's install script from compiling.

A native dependency that ships prebuilt binaries but declares none for the host now fails this job with the dependency name and host key, where it previously failed inside npm as a source-build error, and a dependency installed only below another package fails with its path. A carried dependency whose module cannot be imported fails the job too, which is the case the executable's `--version` could not see.

On a host that can compile, such as a macOS development machine, a platform package built for another architecture is masked: `npm rebuild` source-builds a working addon before the load check runs, so the check passes for a reason the CI runner does not share. The platform package is chosen by name suffix alone, so a libc mismatch is not detected that way and surfaces as a load failure rather than prompting a fallback build.

What the verification proves is a complete payload, resolvable dependency ranges, a starting executable, and one successful import per carried native dependency. It does not build a native module: the binaries are supplied prebuilt, and a dependency that needs a compile step on the host stays outside this proof.
