# Agent Note: BrowserSkill on the user's own browser

Status: implemented

## Problem

The managed runtime launches a Chrome it owns with a separate profile, so the agent never sees the browser the user is actually signed into. Users asked for the opposite: drive the browser that already holds their sessions.

The literal request is closed by Chrome. From Chrome 136 both `--remote-debugging-port` and `--remote-debugging-pipe` are ignored when the data directory is the default one, and Chrome permits one process per profile directory, so attaching to the running everyday browser over CDP is impossible — not a policy this repository could relax. Copying the profile into the owned root was rejected too: it plants a readable credential store inside `$SHRES_HOME`, invisible to the model and the log, and delivers a snapshot that session binding and second-factor prompts erode.

## Decision

A second mode, `paired`, drives the browser the user already has. The runtime starts only the pinned CLI's daemon and mints a one-use pairing link; the user installs the BrowserSkill extension from the Chrome Web Store in their own Chrome and opens the link. The extension dials our daemon, and the agent works in a window it opens inside that browser — same profile, so the user's sign-ins are already there — while the user's existing tabs stay theirs. Tab borrowing is deliberately a later, separately consented capability.

The managed mode stays the default and is unchanged: the isolation guarantee, the hash-pinned artifacts, and the owned-profile lifecycle are what a release ships unless the user chooses otherwise. Mode is durable state in the runtime record, and a pre-mode record reads as `managed`, so no existing install changes behaviour on update.

Paired mode cannot keep the artifact invariants, so it replaces them with narrower ones: pairing is mandatory (upstream's is optional and off by default, and we refuse a trusted-local peer), the store extension's version and permissions are the store's rather than ours, and compatibility is a protocol floor rather than byte equality. "Owned" narrows to the daemon and the pairing: `close` stops our daemon only, `reset` is refused because there is no owned profile, and `unpair` revokes the grants this runtime minted.

## Alternatives considered

**Point the managed launch at the user's profile directory.** Chrome refuses both debugging switches on the default data directory even with Chrome quit, and any other directory is singleton-blocked while the user has Chrome open on it.

**Copy the user's profile into the owned root.** Rejected for the reasons above; a paired browser provides the same logins with no copy, no snapshot staleness, and no agent-readable credential store.

**Replace the managed mode.** The isolation posture carries a recorded decision, a consent card and a README contract; making every user's first run after an update an agent inside their daily browser is not a change a release may make silently.

**Borrow the user's tabs in the first release.** Borrowing puts the agent into a tab holding unsaved work or an authenticated session. Ship attach-without-borrow, which already answers "my sessions are there", and add borrowing behind its own consent.

## Consequences

In paired mode the agent can act as the user anywhere that browser is signed in. That is the feature, and it is why the consent text says so and why the guide forbids signing out, changing account or security settings, entering credentials the user did not give, and touching tabs the agent did not open.

The paired lifetime holds the profile lease from pairing until close, unpair, a mode switch or disposal: teardown paths key off the lease to stop the daemon and the bsk sessions it started. Paired identity is the instance id the pairing activated; the owned label remains a managed-mode proof, because a user's browser reports its own name.

Deferred: tab borrowing; the protocol-floor check and the trusted-local refusal (both are declared in the plan but not yet produced, so neither exists in the vocabulary); a reconnect after the daemon itself is lost; and the Edge listing. Each needs its own measurement before it ships.

Evidence: `packages/browser/browserskill/tests/supervisor.spec.ts` drives pair, attach-without-a-browser-launch, connect-before-pairing refusal, reset refusal, unpair and the mode switch against the fake CLI; `tests/pairing.spec.ts` pins the link and device parsing; `packages/client/ui-browserskill/tests/components.client.spec.tsx` pins the mode strip, the pairing card and the connected controls; the managed guide snapshot is unchanged, which is the proof its body stayed byte-identical.
