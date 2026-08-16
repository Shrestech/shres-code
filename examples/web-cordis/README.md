# web-cordis

Self-referential demonstration of [`@roos-code/roos-code-tool-cordis`](../../packages/extensions/tool-cordis/README.md). The agent can inspect its current Cordis process and mount or unmount model-authored plugins in memory. Temporary plugins disappear when they are unmounted or the process exits and may affect other sessions in the same process. Activating a Host half asks through the session approval channel once per Plugin in the Session (`allowed-once` is the only grant) before any Host code runs; the Web UI answers that ask. Client-half packages still use the existing page approval card. Unattended compositions that must skip the Host-half ask list minted Plugin ids on `cordis-host-runner.hostActivationAllowlist`.

## Run it

Start the browser interface:

```sh
pnpm run demo:cordis
```

Start the ACP automation server instead:

```sh
pnpm run demo:cordis acp
```

Both commands require `DEEPSEEK_API_KEY`. The [Cordis tool reference](../../packages/extensions/tool-cordis/README.md) defines the tool arguments, lifetime, cleanup, and safety contracts.
