# Codex sessions run on the account they are recorded on

<!-- bump: patch -->

## What Changed

When a Codex session was moved to another account (an account swap, or a pin), instar recorded the new account but started Codex on the server's default login, because the Codex launch never set `CODEX_HOME`. Usage landed on the wrong account under the right account's name. On 2026-11-17 three sessions recorded on headley.justin spent Dawn's quota for about three hours.

The Codex launch now sets `CODEX_HOME` to the account's home. Codex can resume a conversation only from its own home, so before the move instar copies the conversation's file into the account's home. The newest copy wins, and an older copy is kept beside it, never deleted. If no copy exists anywhere, the session starts fresh on the right account with a note saying its earlier conversation couldn't be reopened. No login or token is copied.

## What to Tell Your User

- **Account moves for Codex sessions are real now**: "When I move a Codex session to another account, it really runs on that account, so its usage shows up on that account's quota."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Codex sessions launch under their tagged account | Automatic on account swap or pin |
| Codex conversations follow the account | Automatic; the freshest conversation file is copied into the new account's home |

## Evidence

- Unit: `tests/unit/frameworkSessionLaunch.test.ts` (+2), `tests/unit/interactive-session-pin.test.ts` (+4), `tests/unit/codexResumeRollout.test.ts` (6).
- Live (2026-11-18): the sessions' records said `codex-justin-gmail` while their rollouts were written to `~/.codex` (dawn@sagemindai.io) until 19:50 PT.
