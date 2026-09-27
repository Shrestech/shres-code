# Agent Note: Install BrowserSkill from the Web UI with owned browser control

Status: implemented

## Problem

The [managed installation decision](../../implemented/feature/2026-09-24-managed-plugin-and-skill-installation.md) distinguishes plugin packages from skill instructions. Installing BrowserSkill instructions does not provision its executable, daemon, or browser extension. The external CLI route requires separate setup and command permissions. Users need a UI flow that ends with usable browser tools without exposing their normal browser profiles or weakening generic package installation.

## Decision

The optional [BrowserSkill bundle](../../../../packages/bundle/browser/README.md) composes a first-party [host plugin](../../../../packages/browser/browserskill/README.md) and [setup contribution](../../../../packages/client/ui-browserskill/README.md). The [shared plugin activation decision](../architecture/2026-09-27-shared-plugin-activation.md) owns bundle selection and Plugins navigation. Runtime setup provisions resources without changing npm dependencies or plugin selection. The native tools and guide are registered at mount and return a stable not-ready result until the owned browser is connected. The manual skill route remains independently available.

Use the installed Google Chrome executable with a separate Shres-owned profile. The initial supported platform is macOS arm64. Missing Chrome, an unsupported platform, or a version below the extension's minimum is refused before downloading. Extension-protocol compatibility is checked during launch; there is no automatic browser download or manual store-install fallback.

### Consent and artifacts

The confirmation discloses download sources, pinned versions and hashes, owned paths, extension permissions, persistent update-metadata requests, and access to sites the user signs into inside this browser. Request-bound, single-use gesture tokens prevent replay and verb or keep-profile substitution; they do not prove human presence. The entire browserSkill RPC namespace remains loopback-pinned.

Pin the upstream CLI archive, executable, extension archive, and extracted extension tree. Verify staged files before publication. Every execution, including stale recovery before lease acquisition, uses the canonical owned executable path and compiled hash pin; saved paths and hashes are receipts, not execution authority. Verify the extension before every Chrome launch, including retained profiles, because Chrome can load retained extensions before CDP attachment. Open may repair the tree only from a retained archive whose bytes still match the pin; it never downloads. Provision may fetch under consent. Same-filesystem staging and retirement make interrupted publication repairable, not an atomic directory exchange.

No installer script runs. The daemon and commands use absolute executable paths, shell-free argument arrays, private HOME and BSK_HOME directories, and an explicit environment allowlist. BSK_AUTO_START=0 prevents commands from creating an untracked daemon. BSK_AUTO_UPDATE=off prevents binary replacement but does not disable upstream metadata fetches; their configurable URL remains part of consent. Per-harness environment overrides are not inherited.

### Process ownership

Canonicalize the owned root before acquiring runtime ownership, and derive the launch profile and stale-process verifier from that same path. A process-wide registry coordinates runtime copies and HMR; a short filesystem writer mutex serializes lease classification, replacement, updates, and release across hosts. Neither a live lease nor an orphan writer mutex is silently stolen. Child identities are recorded before readiness or extension pairing proceeds.

Reserve both the chosen daemon endpoint and the extension's default endpoint, 52800, before Chrome can contact either. Occupied endpoints refuse startup without eviction or an alternate-port escape hatch. Configure the verified extension through its own service worker, then require the daemon to observe its instance with the owned label before publishing Ready. This is operational identity evidence, not cryptographic authentication of upstream's unauthenticated local WebSocket.

A recorded Chrome process group can be signalled only while its owned leader is unreaped. After leader exit, group inspection is read-only. Profile-marked members prevent release; unmarked members are left untouched and are not claimed dead. This avoids killing a reused group or permanently refusing startup after a reboot. Stale recovery can terminate only recorded processes that pass the profile or daemon-home verification. Daemon recovery issues a bounded stop through the pinned CLI and confirms the verified recorded PID has disappeared; the supervisor does not adopt it or send termination signals. Unreadable process metadata fails closed.

### Operations and browser lifetimes

The runtime records one lifecycle reservation before notifying subscribers or starting work, so synchronous callback reentry cannot create another operation. Every competing request, including an identical request, is refused rather than joined. Accepted work has one never-rejecting settlement promise shared with disposal; the RPC response contains only acceptance and the id. Terminal state is committed before releasing the reservation, and no state is written after terminal notification. The UI waits for that same id's terminal operation, not an older Ready state. Open and Provision while already Ready are no-op successes without lease reacquisition or downloads.

Each opened browser lifetime owns its cancellation controller and tracked commands. Accepting Close, Reset, or Uninstall prevents new tool work immediately. Retirement aborts and drains existing commands before stopping sessions, Chrome, the default-port reservation, and the daemon, then releasing the lease. A late session-start result is compensated on the old daemon before that daemon stops. Old command failures, health results, and exit events cannot retire a newer lifetime.

Internal shutdown uses the same operation reservation as user actions. Tracked work requests shutdown without awaiting its own retirement. Operation settlement waits for retirement started during that operation. A shutdown failure is retained as a result, not swallowed: the lease handle and unconfirmed process identities remain, destructive operations do not proceed, and a later Close can retry. A manual Close joining an internally triggered retirement determines the successful end state. Artifact deletion invalidates the cached provisioning receipt before removal can partially fail, so retrying lease release cannot hide the need to reinstall. Uninstall preserves both lease filenames throughout deletion, releases ownership, then removes only the empty root shell so a successor's state cannot be recursively deleted.

Host disposal aborts startup before requesting forceful termination through the existing single-flight Chrome and daemon stop operations. Synchronous host-exit handlers provide a best-effort backstop; pending launch and verification can exceed the host shutdown deadline, and SIGKILL bypasses exit handlers. The [package reference](../../../../packages/browser/browserskill/README.md#known-limitations-and-deferred-work) owns these recovery limits.

The plugin entry constructs BrowserSkillGateway directly with the runtime and owns the sole awaited disposal effect. No runtime object crosses configuration or becomes a synthetic Context service. Browser sessions belong to the initiating conversation, and ownership, HTTP(S) navigation, and supported interaction arguments are enforced in the executor, not only in tool schemas. Page-derived output is framed as untrusted data.

## Verification

An isolated pilot using installed Chrome 153.0.8010.53, Puppeteer Core 25.12, and pinned bsk/extension 0.3.1 reached a local form, observed it, filled and clicked it, verified the server receipt, and stopped the owned session and daemon. Chrome's load-extension flag was ignored; Extensions.loadUnpacked and extension-worker storage configuration worked. The observed default-port contact count was zero in that run; the reservation, not that timing observation, provides isolation. No model API or everyday Chrome profile was used.

Focused tests cover the runner, daemon, process identities, lease coordination, artifacts, gateway, tools, and UI. A [real-Loader keyless snapshot](../../../../examples/headless-agent/tests/browserskill-native.snapshot.ts) exercises the shipping plugin entry, guide, tool schemas, and not-ready output. It does not establish Web bundle readiness or successful native control.

Real Web runs have completed UI consent, pinned provisioning, Chrome pairing, native session start, navigation, observation, filling and submitting a local form, and session stop. Matching independent server receipts in memory and on disk establish the form action, not merely the scripted model's completion text.

Two fixture defects interrupted the complete scenario: the local macOS automatic picker selected an off-page native chooser, and reference extraction selected a ref-less ancestor with the same label as the input. The fixture pins the existing in-page picker and extracts only observed reference-bearing rows. The first complete-control run exposed a Settings owner-prop collision: its page-closing function replaced the BrowserSkill remote close function. Distinct injected names and a real-slot regression fix that defect; the test fails with the colliding names and passes with the fix.

Supervisor and lease coverage reaches 100% across all four metrics, and the full host build includes the corrected fixture types. The complete real Web scenario passes: UI consent and installation, real browser control with independent receipts, UI Close with confirmed teardown, host restart, Open from retained artifacts with no download, and another confirmed Close. Independent review clears the retirement priority and lost-command handling.

The bounded native recovery scenarios pass on macOS arm64 with installed Chrome. Both the default extension port and the persisted daemon port refuse Open while a test listener holds them, with zero accepted connections and no new browser PID; releasing each listener permits Ready and a confirmed UI Close. SIGTERM exits the Web host normally, leaves the recorded processes gone and the lease released, and permits a no-download reopen. SIGKILL leaves the daemon, Chrome, profile-marked group members, and stale lease present; the restarted host recovers that lease, reaches Ready with the old processes gone, and closes cleanly. The fail-closed refusal alternatives are not taken in this native run.

The removal checks retain every observed PID and process group across attempts and restarts. Three keyless checks use owned benign Node processes to reject removal when an older process or a later recorded group remains; the later-group regression fails before the early-success fix and passes afterward. Successful roots are removed only after the cumulative post-stop checks; structured stdout retains the observations.

The keyless scenarios use a scripted provider and do not establish live-provider behavior. Any separately recorded GUI demonstration must identify its own commit, runtime configuration, and model provenance.

## Alternatives considered

**Keep instructions-only installation as the entire feature.** It avoids runtime ownership but leaves terminal setup and per-command permissions, so it cannot provide immediate UI-installed control.

**Adapt the DeepSeek Harness plugin.** Manifest and package-name mapping may support its shared host APIs, but its UI imports packages absent from Shres. It also expects a separately installed CLI and extension connected to the user's browser; adapting those interfaces alone does not provide the pinned, independently owned runtime required here. General DSH plugin compatibility is a separate concern.

**Relax generic installation to run scripts or provision binaries.** That weakens guarantees shared by unrelated plugins. Browser runtime provisioning has its own consent and pinned artifacts.

**Download a separate browser build.** A testing build offers more predictable extension support, but the user chose the installed executable and no extra browser download. Unsupported installed versions must refuse rather than silently changing that choice.

**Use a default user profile or shared daemon.** That exposes existing sign-ins or another program's browser. A private profile and exclusive endpoints deliberately give up that convenience.

**Write a browser driver.** The upstream daemon and extension already provide browser operations, while maintained Puppeteer handles launch and CDP. A second driver would duplicate those implementations.

**Kill a recorded group after leader exit, or require every old group member to disappear.** Group ids can be reused. The first choice risks unrelated processes; the second can prevent recovery indefinitely. Read-only profile classification preserves the narrower ownership claim and leaves unmarked helpers alone.

**Ignore stale command results without draining commands.** A delayed CLI could still reach a newly opened daemon, and the extension instance id persists across profile reuse. Lifetime cancellation and drainage are required in addition to identity checks.

## Consequences

- A Web profile with the BrowserSkill bundle enabled completes consent, pinned provisioning, Chrome launch, and observed connection without a terminal step.
- Real native tools, invoked through a scripted external model in the actual Web composition, control a local page; an independent server receipt proves the action. A fabricated runtime or executable does not satisfy this criterion.
- Retained-profile reopen reaches Ready without downloading, after launch-time integrity verification. Endpoint conflicts and unverifiable process identity fail closed.
- Close drains tracked work, terminates verified recorded processes, and releases the lease. Host disposal escalates the same stop operations; forced host exit and SIGKILL behavior are measured separately. Failed teardown retains ownership and prevents deletion or replacement; a retried Close can recover.
- Concurrency tests cover commands during teardown, old-lifetime results, internal shutdown reservations, and lease-preserving uninstall.
- Tests use private homes, endpoints, and profiles; they neither read nor modify everyday browser data. Generic installer protections remain unchanged.
- Keyless model-visible snapshots and real-composition UI tests establish their documented scopes; neither substitutes for live-provider evidence.

## Risks

Pins establish byte identity, not publisher trust; the extension has no upstream signed checksum. Local WebSocket pairing is not protection from a same-user impersonator, and files can change after verification. Process listings flatten argv, leaving whitespace-suffixed sibling paths inside the owned root ambiguous. Helpers without the profile token may outlive shutdown and are neither killed nor counted as owned after leader exit. Metadata-query failures or surviving marked processes require manual recovery rather than unsafe automatic cleanup. Chrome-version compatibility, crash recovery, and idle-disconnection behavior require their own measured coverage; successful form control does not establish them.
