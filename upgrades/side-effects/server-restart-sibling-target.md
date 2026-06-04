# Side-effects review — session-safe sibling server restarts

**Scope**: `instar server start|stop|restart` now checks whether the requested
server target is the current session's own project before blocking lifecycle
commands from inside a session. Sibling targets are allowed. Self-targets remain
blocked and now print an actionable supervisor command.

Framework-ledger ref: `57ecfb92`.

## Decision audit

**Candidate A: keep the blanket block and only improve the error.**

This would have preserved the original safety invariant, but it would not remove
the operational friction that caused this task. A mentoring agent still could
not bounce a sibling agent's server from the correct workflow.

**Candidate B: make the guard target-aware and keep a supervisor hint for
self-targets.**

Chosen. It preserves the invariant that a session cannot restart its own
managing server, while allowing maintenance of sibling agents. The supervisor
hint covers the remaining blocked case with an explicit human/operator path.

## Over-block risk

Low. The guard normalizes the current project and target project through
`realpath` when possible. Sibling directories compare different and are allowed.
The only expected block is the current managing server, including symlink aliases
that point back to it.

One residual over-block case remains intentional: if no target is provided from
inside a session, the command targets the current project and is blocked.

## Under-block risk

Low. A symlink to the current project is rejected after realpath normalization.
If a target path does not exist yet, normalization falls back to `path.resolve`;
that could only affect non-existing paths before the server command validates
them. Existing self-targets are protected.

## Level-of-abstraction fit

The comparison lives in a pure core helper. The CLI resolves the optional agent
name before asking the helper for a decision, then formats any rejection for the
terminal. This keeps policy separate from command output and makes the behavior
directly unit-testable.

## Signal vs authority

The helper is authority for this CLI guard only. It does not change supervisor,
launchd, systemd, or server internals. The server lifecycle implementation still
owns the actual start/stop/restart mechanics.

## Interactions

- `server start [name]`, `server stop [name]`, and `server restart [name]` now
  resolve the agent name before applying the guard.
- `--dir` targets are compared directly.
- `status [name]` is unchanged except that `resolveAgentDir` is now statically
  imported by the CLI.
- Supervisor-managed restarts remain the documented path for the current agent.

## External surfaces

User-facing behavior changes only for CLI output and command allowance:

- Sibling server lifecycle commands from inside a session can proceed.
- Self server lifecycle commands still fail, with a clearer message and
  `launchctl kickstart -k gui/$UID/ai.instar.<name>` hint.

No API keys, credentials, network calls, or config migrations are involved.

## Rollback cost

Small. Reverting the helper, CLI call-site changes, tests, and upgrade artifacts
restores the prior blanket in-session block.

## Tests

Narrow regression coverage checks:

- no session id allows lifecycle commands;
- current managing server rejects;
- sibling target allows;
- symlink target resolving to the current managing server rejects.
- docs coverage documents `SessionServerGuard` in two indexed docs so the core
  category stays at its configured floor.

Local verification intentionally uses targeted tests and static gates under the
current host load; CI remains the full matrix authority.

## Conclusion

This change removes the Gemini-onboarding friction without weakening the
conversation-safety invariant that motivated the guard in the first place.
