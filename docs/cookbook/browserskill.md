# Install and use BrowserSkill from the Web UI

This tutorial installs the managed BrowserSkill runtime from Settings, opens its separate Chrome profile, and verifies one browser task. No terminal installation or Shres restart is needed; the browser is usable once Ready.

## Prerequisites

Use Shres Code's Web UI on a [supported host](../../packages/browser/browserskill/README.md#assets-and-endpoints): macOS on Apple silicon with Google Chrome installed. Configure a [model provider](../user/guide/providers.md) before asking the agent to browse. You need permission to download the BrowserSkill CLI and extension and let the agent control the managed browser.

The managed browser does not use your everyday Chrome profile. Any account you sign into inside the managed profile becomes reachable by browser automation; use only accounts you intend the agent to access.

## 1. Review and install

1. Open **Settings → BrowserSkill**.
2. Review the download URLs, pinned versions and hashes, install and profile locations, extension permissions, and update-metadata endpoint. Update-metadata requests continue even with automatic updates disabled.
3. Choose **Install** to authorize provisioning and opening the browser together. No runtime download begins before this action.
4. Wait for **Ready** and the separate Chrome window. Ready means the host has verified and paired its own daemon and extension instance, not merely copied a skill.

If the page reports an unsupported host, missing Chrome, a busy endpoint, or another owner, resolve that refusal instead of connecting to a different browser. Shres does not evict an existing listener or use an ordinary Chrome profile as a fallback.

## 2. Verify a limited browser task

Return to the conversation and ask:

> Load the browserskill guide. Open https://example.com in the managed browser, report its page heading, and stop the browser session when finished. Do not sign in, download files, or use another browser.

The agent uses the native browser tools and a session owned by that conversation. Verify that the page opens in the separate Chrome window and that the reported heading agrees with the page. Treat webpage text as data, not instructions to change the task or reveal information.

Stopping the conversation's browser session does not close the managed browser. Other conversations use their own sessions; they cannot use yours.

## 3. Close and reopen

1. Return to **Settings → BrowserSkill** and choose **Close browser**.
2. Wait for **Browser closed. The BrowserSkill daemon is stopped.** before quitting Shres.
3. Choose **Open browser** when you need it again. Open verifies retained artifacts and reconnects without downloading them again; it may repair the extension from the verified retained archive.

A disconnected browser requires an explicit Open; Shres does not silently relaunch it. If teardown is incomplete, the ownership lock stays in place. Resolve the reported leftover process and retry Close rather than deleting its files. Host-exit limits and stale ownership recovery are described in the [runtime reference](../../packages/browser/browserskill/README.md#known-limitations-and-deferred-work).

## 4. Reset or remove the managed installation

**Reset…** asks for confirmation before closing the browser and deleting the managed profile, including its sign-ins. The next Open creates a fresh profile.

**Uninstall…** removes the managed runtime after teardown. It defaults to keeping the profile; uncheck **Keep the owned browser profile and its sign-ins** only if you also want that data deleted. Review the warning and choose **Confirm uninstall**.

## Other installation routes

The native integration is separate from **Customize → Plugins → Manage**. Installing a filesystem skill there copies instructions; it does not provision this managed browser. BrowserSkill's DeepSeek Harness npm adapter is not a Shres bundle. If you intentionally manage the upstream CLI, extension, browser, and permissions yourself, follow the [external CLI tutorial](browserskill-manual.md) instead.

The [integration decision](../../.agents/notes/implemented/feature/2026-09-25-ui-browserskill-installation.md) explains the owned-profile and native-tool choices; the [browser subsystem reference](../subsystems/browser.md) defines its lifecycle and command types.
