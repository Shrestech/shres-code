# bundle/ — profile plugin bundles

Profile bundles: npm packages whose manifest declares `"shres": { "bundle": { "patch": "./cordis.patch.yml" } }`, making them installable patch layers for `shres --profile` compositions ([profile contract](../boot/app-boot/README.md#profiles)). A bundle's substance is its patch list; some also ship runtime glue plugins their patch mounts.

| Package | Role | ctx key |
|---|---|---|
| [`base/`](base/README.md) | The shared shres core every profile applies first | — (patch only) |
| [`web-app/`](web-app/README.md) | Browser surface: web patch layer + runtime glue plugin | mounts rows |
| [`browser/`](browser/README.md) | Optional BrowserSkill host and Plugins layer over the Web surface | mounts rows |
| [`headless/`](headless/README.md) | Direct one-shot task mode over base, with no Host or Web layer | mounts `headless-runner` |

In-box bundles resolve from the shres installation; out-of-tree bundles install into a profile through `shres plugin --profile <name> add <package>`.
