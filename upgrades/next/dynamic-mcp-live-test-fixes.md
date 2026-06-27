<!-- bump: patch -->

## What Changed

Three bug fixes to the **Dynamic MCP Lifecycle** (⚗️ experimental, dark) that a
real test-as-self run through Telegram surfaced — every one invisible to the unit/
integration/e2e suite because those tests hand the code objects directly instead of
going through the real front doors (browser auth, form parsing, config loading,
session restart):

1. **The feature was un-enablable** (#1296). `loadConfig()` silently dropped
   `sessions.dynamicMcp` because the field was never added to the config loader's
   passthrough — so flipping the switch did nothing and a new session always launched
   with the full toolset. (This is the *third* recurrence of the add-a-setting-but-
   never-wire-it-into-the-loader class of bug in this codebase.)

2. **The operator-approval tap page was unreachable from the operator's browser**
   (#1295). The approval route was gated behind the agent's shared Bearer token —
   which the operator's phone browser does not hold — and the PIN box did not actually
   submit the PIN. So a real tap-to-approve could never complete. Fixed at the layers
   that exercise the real login/form path, with tests added there so it can't regress.

3. **Load-on-demand was a no-op on its own restart** (#1297). The load path recorded
   the new toolset as `pending`, restarted, and only marked it `confirmed` *after* the
   restart — but startup deliberately ignores a `pending` set, so the session came back
   lean and the load only took effect on the *next* restart. Fixed by committing the
   loaded set to `final` BEFORE the restart, with the existing rollback preserved (a
   failed restart still falls back to the prior set).

Still dark by default — these fixes restore the feature's intended behavior behind the
flag; they do not enable it.

## What to Tell Your User

Nothing changes unless Dynamic MCP is explicitly turned on, which it is not by default.
If a user is trying out the feature: it can now actually be turned on, the tap-to-approve
flow works from a phone, and loading a tool on demand takes effect on the first restart
instead of the second.

## Summary of New Capabilities

- Dynamic MCP `sessions.dynamicMcp` config now actually reaches the session-launch
  decision (was silently discarded by the config loader).
- Operator tap-to-approve (`POST /mcp/approve`) is reachable by the operator's
  PIN-authenticated browser, not just the agent's Bearer token.
- Load-on-demand applies on its own restart instead of requiring a second one.

## Evidence

Each fix shipped with tests at the layer that actually exercises the real path
(config-loader passthrough, the PIN/auth route, the load-ordering safe-commit). The
full feature suite (~378 tests) is green; tsc clean. All three merged to main (#1295,
#1296, #1297) but did not cut a release because no upgrade-guide fragment accompanied
them — this fragment is that missing piece, authored so the release pipeline cuts the
version that carries these fixes to the fleet.
