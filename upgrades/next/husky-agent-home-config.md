# Pre-commit: read requireConvergenceReport from the agent home

<!-- internal-only -->
<!-- bump: patch -->

## What Changed

`.husky/pre-commit` decides whether to export `INSTAR_DEV_REQUIRE_CONVERGENCE_REPORT=1` by reading `specReview.requireConvergenceReport` from a config file. It looked only in the main checkout (`.instar/config.json`, `instar.config.json`) and in the current checkout. On a fleet whose agents live under `~/.instar/agents/<agent>/`, none of those four paths exists, so the flag could never be turned on: setting it to `true` in the dev agent's config changed nothing, and the commit gate's report-backing requirement failed open. The hook now reads `$INSTAR_AGENT_HOME/.instar/config.json` first. The agent launcher already exports that variable to every session it spawns (`SessionManager`, `-e INSTAR_AGENT_HOME=<projectDir>`). The other four paths stay as fallbacks, and every read error still leaves the variable unset.

## Evidence

The hook's probe was run with each condition, old version against new (exit 0 = enforce):

| condition | old | new |
|---|---|---|
| agent home config, flag `true` | 1 | **0** |
| agent home config, flag `false` | 1 | 1 |
| `INSTAR_AGENT_HOME` points at a missing dir | 1 | 1 |
| `INSTAR_AGENT_HOME` unset | 1 | 1 |
| the real `echo` agent home (flag `false` today) | 1 | 1 |

Only the first row changes. No agent on the measuring machine has the flag set to `true` today, so no commit behaves differently until an operator turns the flag on.
