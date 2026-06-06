<!-- bump: patch -->
<!-- internal-only -->

## What Changed

Made the three `telegram-reply.sh` test harnesses hermetic against a live
agent session's environment: each script-spawn now blanks
`INSTAR_AUTH_TOKEN` so the script exercises the config-file auth fallback
the tests intend, instead of inheriting the runner's real session token
(which the test servers' auth middleware correctly rejects, failing the
tests only when run inside an agent session). Same hermeticity class as
the #862 unit-suite fix, applied to the reply-script family.

## Evidence

- Bisected: `tests/integration/telegram-reply-end-to-end.test.ts` fails
  with `INSTAR_AUTH_TOKEN` exported, passes without; single-var culprit.
- Post-fix: all 4 reply-script test files (32 tests) green BOTH under a
  live agent env and a stripped env.
