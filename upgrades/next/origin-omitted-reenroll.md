# Credential-stripped sessions no longer regain an origin credential after a restart

<!-- bump: patch -->

## What Changed

SEC-107. `enrollExistingOriginSessions`, which runs at server start, re-issued an `INSTAR_ORIGIN_TOKEN` into the tmux environment of EVERY running session that had a framework. It did not check whether the session had been launched with `omitAuthEnv`, which blanks that token on purpose. Credential-stripped and confined sessions therefore regained an origin credential after any restart, readable with `tmux show-environment` wherever the sandbox allows the socket. Those sessions still lack the API bearer, so a send also needed that.

Both credential-stripped launch paths (headless, and the rerouted Claude path used by confinement) now set `INSTAR_ORIGIN_OMITTED=1` beside the blank token. Before re-enrolling a session, enrollment checks two things:

- **The marker.** If the session carries it in any form (set, blanked, or removed), it is stripped.
- **The agent token, for sessions started by an older build.** These have no marker, but if `INSTAR_AUTH_TOKEN` is blank while this agent has a token, the session is stripped. Both stripped paths blank it and every normal path sets it, so this also covers the upgrade restart itself.

A stripped session is skipped, and any credential it already held is revoked. An unknown variable (tmux exit 1, "unknown variable") means a normal session, which is re-enrolled as before. Any other tmux failure (no such session, timeout) holds enrollment closed for that session.

## What to Tell Your User

- **Locked-down helpers stay locked**: "The sessions I start without any of my keys used to quietly get one small key back whenever I restarted. They don't anymore."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Stripped sessions keep no origin credential across restarts | Automatic |

## Evidence

- Unit: `tests/unit/telegram-origin/session-manager-origin-lifecycle.test.ts`. The tmux mock now keeps each session's own environment from `new-session -e`, and an unknown key exits 1 with "unknown variable", as real tmux does. The new cases:
  - a stripped launch writes the marker and a blank token, and enrollment reads exactly what it wrote and never re-arms the session;
  - a marked session that already held a token has it revoked;
  - a blanked or removed marker still counts as stripped;
  - a session from before the marker, with a blank agent token, is not re-armed;
  - a normal session is still re-enrolled;
  - a failure on the marker lookup alone holds enrollment closed.
- With the skip disabled, all 5 skip tests fail. The suite has 23 tests, and the 5 related spawn and migration files pass 68 tests.
