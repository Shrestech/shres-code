# Use BrowserSkill with Shres Code

This tutorial connects an installed agent skill to a separately installed BrowserSkill CLI. It does not install a native Shres plugin. The command forms below follow [BrowserSkill at commit `147727a0e2ded65a7d0f364beea8cc2ebcdec8af`](https://github.com/Tencent/BrowserSkill/tree/147727a0e2ded65a7d0f364beea8cc2ebcdec8af); check that revision’s help before using a different version.

## Prerequisites

You need Shres Code, Git, and permission to install a browser extension. Use a new, dedicated browser profile: browser automation can act with the cookies and logged-in sessions of the connected profile. Do not connect your everyday profile merely to test installation.

The Shres installer copies the skill’s instructions and resources. It does not install or update `bsk`, start its daemon, install the extension, or open a browser. Running `bsk` later can start its daemon according to upstream configuration. BrowserSkill’s DeepSeek Harness npm plugin is not a Shres bundle; `install-plugin` refuses it rather than translating its APIs.

## 1. Prepare the external runtime

Review and follow the pinned [upstream setup instructions](https://github.com/Tencent/BrowserSkill/blob/147727a0e2ded65a7d0f364beea8cc2ebcdec8af/README.md) to install `bsk` and the extension yourself. Inspect downloaded installation scripts before deciding whether to run them. Install the extension only in the dedicated profile, then connect that profile as directed upstream.

In your terminal, check the CLI and its diagnostics:

```sh
bsk --version
bsk --help
bsk doctor
```

A successful terminal check does not prove that Shres’s bash tool can reach the same daemon.

## 2. Install the skill copy

Clone a reviewable upstream revision into a new directory and copy its skill through Shres:

```sh
git clone https://github.com/Tencent/BrowserSkill.git BrowserSkill
git -C BrowserSkill checkout --detach 147727a0e2ded65a7d0f364beea8cc2ebcdec8af
shres skill add ./BrowserSkill/crates/bsk-cli/skill
shres skill list --json
```

Confirm that `browser-skill` is listed. The copy is independent of later checkout edits, and the installed instructions are framed as untrusted when loaded. A same-name skill from a higher-priority source can shadow it; Web Customize → Plugins → Manage reports globally visible shadows. For precedence, collision handling, and removal, see the [installed-skill reference](../../packages/skill/skill-filesystem/README.md).

## 3. Verify access from Shres

In a Shres session, ask the agent to run `bsk --version` and `bsk doctor` through its bash tool without starting a browsing task. This checks the actual executable search path and daemon access used by the agent. Restart a launcher whose environment predates the CLI installation if `bsk` is not found.

The default `workspace-write` preset restricts writes to the workspace and temporary roots, while confined bash denies outbound network by default. On macOS that denial also covers local socket connections. BrowserSkill’s default daemon state under `~/.bsk` and its local connection therefore need permissions beyond that default. Linux behavior depends on the sandbox backend and daemon transport. See the [CLI permissions reference](../../apps/cli/reference/README.md) and [sandbox provider reference](../../packages/sandbox/sandbox-local/README.md).

Do not change permissions automatically to make the check pass. Review a specific permission request with the operator; if approval is unavailable or refused, stop setup. Full-access execution removes file and network confinement, not just access to BrowserSkill. A deployment-wide network opt-in affects other commands too. Starting the daemon outside Shres with upstream’s `BSK_AUTO_START=0` arrangement does not by itself grant a confined client permission to connect.

## 4. Run one limited task

After diagnostics pass inside Shres, ask:

> Load the browser-skill skill. Use only the dedicated browser profile to open https://example.com, summarize the page, and stop the browser session when finished. Do not sign in, download files, or use any other profile.

The documented CLI sequence is:

```sh
bsk session start --no-focus --json
bsk navigate https://example.com --session SESSION_ID
bsk observe --session SESSION_ID
bsk session stop SESSION_ID
```

Replace `SESSION_ID` with the returned session id; `session stop` takes it positionally. If more than one browser is connected, select the dedicated one using the upstream `--browser` option when starting the session. Confirm the page result and session cleanup before considering the integration usable. Remove only the copied skill with `shres skill remove browser-skill`; external runtime and extension removal follow upstream procedures.

## Verification limits

The repository’s keyless example exercises installed instructions and the real bash tool against an explicitly synthetic `bsk` executable. It verifies Shres integration paths, not the real BrowserSkill daemon, extension, browser behavior, or authentication. A successful skill installation alone does not establish browser readiness.
