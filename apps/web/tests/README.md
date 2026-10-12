# apps/web browser e2e

Most scenarios boot the real Web composition in-process and drive Chromium over real HTTP. The lane’s mechanics, fixtures, goldens, and deliberate differences from `shres web` are documented in [`scaffold.ts`](scaffold.ts)

## Managed installation

[`plugin-manage.e2e.ts`](plugin-manage.e2e.ts) launches the source CLI through its ESM-only hook with built Web assets, an explicit child environment, temporary state roots, offline pnpm, and a new Playwright browser. Its fixture blocks external `fetch` calls in the Web process without changing the shipped plugin composition; it makes no model calls. Filesystem assertions and ARIA goldens cover skill copies, consent and cancellation, build-script refusal, retained plugin sources, and activation and removal across process restarts.

## Opt-in native BrowserSkill evidence

The real scenarios in [`browserskill-real.e2e.ts`](browserskill-real.e2e.ts) require `SHRES_BROWSERSKILL_REAL=1` on darwin-arm64 and `SHRES_BSK_ASSET_DIR` pointing at the pinned release assets. They boot the source CLI with built Web assets, isolated realpath `/tmp` roots, and loopback artifact, form, and update-metadata endpoints. The control scenario drives Settings consent and installation, one scripted-model agent round through the real browser tools, independent form receipts, UI Close, and a restart that reopens without downloading. Metadata requests must reach the owned endpoint only after consent.

Also set `SHRES_BROWSERSKILL_REAL_UNHAPPY=1` for occupied-port and host-exit scenarios, each with fresh roots. Port probes require a refusal naming the occupied default or persisted endpoint, no connection to or eviction of the listener, and Open/Close recovery after its release; an endpoint already busy at probe time is reported as skipped rather than disturbed. SIGTERM requires a normal Web-host exit and confirmed owned-process teardown before reopening. SIGKILL records the observed stale state, then requires Ready or a specific fail-closed refusal, with old and new process identities included in the final teardown checks. These probes signal only the test-spawned Web process. Three keyless checks exercise the removal checks with benign owned Node children; the process-group check is POSIX-only.

The model API and external Node fetch are disabled; Chrome's background traffic is not confined. Native teardown inspects the lease, PID/PGID metadata, and command lines only within recorded groups, without signalling Chrome or the daemon. Every failure preserves its root. Removal requires the Web host stopped, the lease released, every recorded daemon and browser PID confirmed reaped, and every recorded group free of profile-marked members. Unmarked members are disclosed and never claimed dead. Structured observations are printed to stdout; `result.json` survives only in preserved roots because successful roots are removed.

Milestones use semantic assertions rather than ARIA goldens: disclosed states contain per-run loopback ports that the shared normalizer cannot collapse.

## These are Host-face tests

They type-check in the root `tsconfig.host.json`, not in the Client aggregate,
because they read Host services directly: `ctx.apiProxy`, the Host
`SessionStore`, `ctx.sessionProjectionCache`. Driving a browser at runtime does
not make a file part of the Client program — the two faces merge cordis
`Context` under the same keys with different services, so one program cannot see
both. Moving these files into the Client aggregate makes every Host-service
access fail to compile.

## Do not import `@shres-code/shres-code-client-*` here

Importing a Client package — a value or a type — pulls its whole TypeScript
project, and every project it references, into the **Host build graph**. That has
bitten this lane once already: four Client consumer packages reference
`api/remotes`' Client face, which cannot compile until Host tsdown has generated
`@shres-code/shres-code-goal/remote`, so the Host build phase ended up waiting on an
artifact it produces itself.

When a scenario needs a Client-owned constant or pure function, mirror it here
instead, next to the commented-out import that names the source module. A drift
then surfaces as a missed selector or a stale mirrored value — a loud failure,
never a silent pass. `scaffold.ts` follows this rule for the welcome-notice
namespace, acknowledgement field, version, and asserted English copy.

Two kinds of Client import stand. `assembled-boot.ts` drives the shell itself, so
it imports `AppWebEntry` from `@shres-code/shres-code-client-web` and the boot-manifest
type from `@shres-code/shres-code-client-modules/client`: booting the real shell is what
that harness is for, and both packages are already in the Host graph. Separately,
the chat scenarios import `conversationContextKey` from
`@shres-code/shres-code-client-runtime/client` because `client/runtime` is reachable
through the unsplit `directory-picker` packages and pulls nothing further in.
That reachability is incidental, not a guarantee — if it ever leaves the graph,
mirror the helper like the rest.

Nothing mechanically enforces this rule; keep it in review.
