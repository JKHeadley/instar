# Development updates during a publishing outage

When npm publishing is unavailable, the **Development release (no npm publishing)** GitHub workflow builds current main into a GitHub prerelease. It uses no npm account credentials. npm installs of public dependencies must still work. These releases are opt-in for development and temporary agents. They do not change the stable channel, npm tags, release version, or consume pending upgrade fragments.

Run from a clean current main checkout:

```sh
gh workflow run development-release.yml --ref main
gh run list --workflow development-release.yml --limit 1
```

Wait for that run to succeed, then obtain its exact source SHA from the run/release. Each immutable release is named `dev-<full-source-sha>`. Download only from the trusted `JKHeadley/instar` repository, using your authenticated GitHub CLI. The checksum detects corruption; it is not a signature establishing trust in an arbitrary manifest.

```sh
gh release download dev-FULL_SOURCE_SHA --repo JKHeadley/instar --dir /tmp/instar-development
node scripts/development-release.mjs install /tmp/instar-development /absolute/path/to/agent
```

The installing checkout must have been built with this capability. The installer verifies the manifest and SHA-512 of a private snapshot before npm reads it, then uses the normal UpdateChecker pipeline: separate candidate, dependency/native rebuild, exact version and CLI startup probe, atomic promotion with recovery backup, rollback record and post-update migrations. Any validation failure leaves the active installation in place. Never install an artifact from an untrusted release; package installation and migrations execute code.

Run installation only while no other update/install is active for that agent. Request its normal session-aware update restart after success; never kill its sessions to force the change. Check `/health` and the shadow package version after restart. Repeat for each explicit agent home on each machine; no hidden fleet-wide rollout occurs. An offline machine can use the same downloaded artifact later.

For a local build without GitHub, `node scripts/development-release.mjs pack /tmp/instar-development` produces the same artifact and manifest. Use a clean checkout. macOS produces both desktop host architectures; universal-native validation prevents shipping a partial desktop package.

Development versions use `<last-stable>-dev.<source-timestamp>.<sha>`, preserving the stable patch number. The first later npm patch is newer under the existing updater comparison, so normal automatic updates return agents to stable after the hold lifts. To return immediately before a newer stable exists, use the existing rollback command; it restores the prior published stable base and requires npm install availability. It never requests an unpublished development version from npm, even after several development installs. The installer uses the target agent's Node runtime for native rebuilds. Do not bump a development artifact above the next stable patch or pin a replacement registry.
