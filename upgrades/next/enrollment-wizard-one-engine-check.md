# Main passes its own engine-name check again

<!-- bump: patch -->

## What Changed

`src/core/EnrollmentWizard.ts` named the Claude engine (`'claude-code'`) in two separate conditions. The second one arrived with the stale follow-me sign-in fix (#3147), which was tested on a base from before the framework-id ratchet (`scripts/lint-framework-name-ratchet.mjs`, added by #3098) existed. Once both were on main the ratchet counted 1136 literals against a baseline of 1135, so `npm run lint` failed on main and on every change tested on top of it.

Both conditions now call one file-local helper, `isClaudeCodeLogin(login)`, so the file holds a single literal, as the baseline records. Behaviour is identical: the same two Claude-only steps run for the same logins. The baseline file is not changed.

## What to Tell Your User

Nothing changes for you. This repairs a development check so that new features can be tested and merged again.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|------------|
| None (internal repair) | Not applicable |

## Evidence

- `node scripts/lint-framework-name-ratchet.mjs` on main at 05364c0735: "framework-id literals outside the adapters grew: 1135 -> 1136 ... src/core/EnrollmentWizard.ts: 1 -> 2". With this change: "clean — 1135 framework-id literal(s)".
- Existing coverage of both call sites is unchanged and still applies: `tests/unit/enrollment-wizard.test.ts`, `tests/unit/enrollment-already-signed-in-server-wiring.test.ts`, `tests/e2e/subscription-enrollment-lifecycle.test.ts`.
