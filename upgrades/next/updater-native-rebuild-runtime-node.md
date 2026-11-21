# Self-updater builds its SQLite binding for the Node that runs the agent

<!-- bump: patch -->

## What Changed

When the agent installs an update, it rebuilds one compiled dependency (the `better-sqlite3` database driver) and then checks that the new version starts and can open a database with the agent's own Node. The rebuild used to run `npm` from the machine's PATH, which runs under whichever `node` is first on PATH; on a machine where that is a different Node major (Homebrew Node 22 while the agent runs its own Node 24), the binding was built for the wrong Node and every update was refused (Echo Studio, 2026-11-20/21, kept back on 1.3.1944). The updater now runs the runtime Node's own bundled `npm` with that Node, puts the runtime Node's directory first on PATH for the build, and points node-gyp at the runtime's bundled headers (`npm_config_nodedir`) when present. If the runtime Node bundles no `npm`, it falls back to `npm` from PATH under the same PATH prefix and logs that it did. Rollback uses the same invocation. Separately, `POST /updates/apply` now has its own 15-minute request budget: it awaits the whole install, and under the 30-second default the server answered 408 early and then dropped the real answer as a "Suppressed duplicate response send".

## What to Tell Your User

- **Updates install again on machines with more than one Node**: "If this machine kept failing to take updates with a message about NODE_MODULE_VERSION, that is fixed: the update now builds its database driver for the same Node that runs me, no matter which Node your system has on its path."
- **Applying an update by hand waits for the real answer**: "When you ask me to apply an update right away, the request now waits for the install to finish instead of timing out after 30 seconds."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Native rebuild targets the agent runtime Node (ABI-correct) | Automatic on every update and rollback; no setting |
| `POST /updates/apply` 15-minute request budget | Automatic; the route returns the updater status when the install finishes |

## Evidence

`tests/unit/update-checker-apply.test.ts` ("native rebuild runs under the runtime node": a different Node major first on PATH; asserts the runtime node runs its bundled npm-cli.js, its directory is first on PATH, `npm_config_nodedir` is set; the logged fallback when no npm is bundled; rollback uses the same path) — all three fail against the previous code. `tests/unit/AgentServer-outbound-timeout.test.ts` asserts the production override map routes `/updates/apply` to the new budget while `/updates/auto` and `/updates/rollback` keep the default. `tests/unit/UpdateChecker.test.ts` and `tests/integration/native-update-preflight.test.ts` (real CLI + real SQLite probe) pass with npm faked at the new seam. Live trigger: `GET /updates/auto` on the Studio, 2026-11-21 03:10 PST: "better_sqlite3.node was compiled against a different Node.js version using NODE_MODULE_VERSION 127. This version of Node.js requires NODE_MODULE_VERSION 137" (feedback fb-962cbcf0-0ae, fb-843b9795-666).
