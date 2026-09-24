# Shres Code Python packages

Python packages for driving Shres Code as a subprocess, and the local Laya judgment gateway. The client SDK communicates with the bundled runtime over newline-delimited JSON-RPC on stdio.

## Packages

| Directory | Dist / module | Role |
|---|---|---|
| [sdk](sdk/README.md) | `shres-code-sdk` / `shres_code` | High-level turns API and lower-level JSON-RPC client |
| [sdk-runtime](sdk-runtime/README.md) | `shres-code-runtime-bin` / `shres_code_runtime` | Bundled runtime binaries and default agent configuration |
| [laya-gateway](laya-gateway/README.md) | `shres-laya-gateway` / `laya_gateway` | Loopback Shield-wire gateway for local Laya judgments, installed and supervised by `@shres-code/shres-code-judgment-laya`; not published to PyPI |

## Behavior

The SDK starts the matching bundled runtime unless the caller selects an explicit channel. The client selects the channel and supplies default configuration; the runtime itself always requires an explicit configuration. The [SDK reference](sdk/README.md) and [runtime carrier reference](sdk-runtime/README.md) own the complete runtime-selection and configuration contracts.

## Contributor workflows

The [Python contributor workflows](development.md) cover building runtime artifacts, validating the packages, source-mode development, and distribution.
