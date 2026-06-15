# Upgrade Guide — NEXT

<!-- bump: patch -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

An internal correction to the stop-gate's autonomous-run detection. The gate that
decides whether a stopping session is a registered autonomous run was reading only
an old single-file convention that modern runs no longer write — so a run that
registered itself per-topic was invisible to the gate and got treated as a plain
idle session, defeating the revive-it-later safety net.

The read now follows a fixed precedence chain: the canonical per-topic registration
under the .instar autonomous directory first, then the .instar legacy single-file,
then the oldest .claude legacy single-file. autonomousActive is true if any exists.

To check the per-topic path the server now resolves the serving topic itself: it
maps the Claude session id to its tmux session name via the session manager, then
inverts the topic-session registry on that name — the same inversion the bash stop
hook already uses. A resolution miss (no session record, corrupt or missing
registry, unknown name) explicitly falls back to the legacy paths and NEVER silently
returns a false negative — the no-silent-fallback boundary, annotated and covered by
tests on both sides.

This is the deterministic read-path fix. The dev-gated registration-guard that
auto-writes a registration stub when a run starts without one is a distinct change
specified separately in the spec's PR2 section.

## Evidence

- tsc clean; full lint clean (no-silent-fallbacks ratchet green over the annotated catches).
- 38 tests green across tests/unit/stopGate.test.ts (D1 precedence, the D2 unresolved-topic boundary both sides, and the resolveTopicForTmux registry inversion) and tests/integration/stop-gate-autonomous-topic-resolution.test.ts (the full HTTP hot-path UUID to tmux to topic resolution).
- Server-only change — no agent-installed file touched, so no migration parity is required.

Side-effects review: upgrades/side-effects/autonomous-run-registration-guarantee.md

## What to Tell Your User

Your autonomous runs are now recognized more reliably when a session stops. The check that
decides whether a stopping session is a real autonomous run used to look only at an old
location that current runs no longer write, so a run that had registered itself could be
mistaken for an idle session. It now looks at the modern per-run location first and falls
back to the older ones, and it figures out which conversation it is looking at on its own.
If it cannot tell, it still checks the older locations rather than assuming the run is idle.
You do not need to do anything; this just makes the autonomous safety net harder to miss.

## Summary of New Capabilities

No new capabilities or APIs. This is a correctness fix to an existing internal check —
behavior only, fully backwards compatible, and reversible.
