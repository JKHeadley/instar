# Upgrade Guide — v1.0.1

<!-- bump: patch -->

## What Changed

Codex topics now actually resume into their prior session when one has been tracked. Before this release, the launch helper recognized that a topic had a tracked Codex session id but logged a warning and started fresh anyway — the resume id was thrown away. After this release, the helper rebuilds argv with `codex resume <SESSION_ID>` as a subcommand inserted right after the binary path, with all the usual sandbox / model / `--oss --local-provider` flags accepted by the `resume` subcommand verbatim.

The implementation is in `src/core/frameworkSessionLaunch.ts` (codexCliBuilder). One small refactor: `resumePrefix` is built first (either `['resume', <id>]` when resuming, or empty for fresh), then spread into argv between the binary path and `--model`. The prior warning is removed. Codex's flag-style `--resume` was never accepted by the binary in the first place; the new shape matches what `codex resume --help` documents on Codex 0.130.

Stale-id handling: if the tracked SESSION_ID no longer exists in Codex's session store, `codex resume` exits non-zero at startup and the tmux pane shows an error. SessionManager's respawn logic catches the dead pane, and the route handler can clear the stale resume id (same pattern PR #248 established for framework swaps clearing resume ids whose scheme no longer matches the new framework).

In capability-matrix terms (from `specs/instar-foundations/required-primitives-inventory.md` once it lands on main), this shifts primitive #7 Session-resume on Codex from `partial ⚠️` to `native ✓`.

## What to Tell Your User

- "Codex sessions you've been chatting with now actually pick up where they left off after a restart. Before, restarts silently started a fresh session and lost the conversation thread."
- "No action needed. Topics that were tracked with a Codex session id will resume the next time they restart."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Codex session resume | Automatic — when a topic has a tracked Codex session id, launch uses `codex resume <id>` as a subcommand |

## Evidence

The bug was reproducible: any Codex topic that had a tracked session id and got respawned (manually, via /restart, or via lifeline recovery) logged a `console.warn` about Codex resume being a subcommand and started fresh — the user's conversation history in that session was gone from Codex's view (Instar's topic history was still there, but the model lost continuity).

Unit tests confirm the new argv shape:

- `resume <id>` inserted at positions 1 and 2 of argv when `resumeSessionId` is set
- No `resume` token in argv when `resumeSessionId` is absent (fresh launch unchanged)
- Sandbox flags (`--sandbox`, `--ask-for-approval`, `--dangerously-bypass-approvals-and-sandbox`) preserved when resuming
- Local-model flags (`--oss`, `--local-provider`) preserved when resuming
- The flag-style `--resume` is never emitted (Codex doesn't accept it)

Test file: `tests/unit/frameworkSessionLaunch.test.ts` (38/38 passing — 4 new tests in the codex-cli describe block, 1 prior test updated from "should-not-resume-because-not-supported" to "should-insert-subcommand"). Typecheck: clean.
