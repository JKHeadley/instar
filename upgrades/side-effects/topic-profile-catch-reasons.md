# Side-effects review: topic-profile change questions log their caught failures

## What changes
Five catch paths added by this PR (profile change questions) now log a one-line `console.warn` with the error message, and carry an in-place `@silent-fallback-ok` reason:
- `src/core/handleProfileProposalReply.ts`: acknowledgment delivery failure. Still returns `acknowledgment: 'failed'`, and the committed result is untouched.
- `src/core/profileProposalPlacement.ts`: unreadable placement. Still returns null, which fails closed and cannot authorize a proposal.
- `src/core/topicProfileWriteSurface.ts`: the not-restarted disclosure. The settings stay saved and the reply is still returned; a failed disclosure is now logged instead of swallowed by an empty `.catch(() => {})`.
- `src/server/routes.ts` clarifyPending: an unverifiable pending proposal is still left out of the clarification list, so it fails closed.
- `src/server/routes.ts` question delivery: it still completes the attempt, disarms the slot and returns 502; now also logged.

## Behavior
No return value, status code, message text or authority changes. The only addition is a log line on each failure path. No fallback gains authority: the two that decide eligibility both still fail closed.

## Why
The silent-fallback ratchet (`tests/unit/no-silent-fallbacks.test.ts`, baseline 493) counted these catches as new silent fallbacks: 497 on the merged tree. The ratchet number is not raised. Each path now states why it is safe, and the count is back within 493.

## Risks considered
- **Log volume:** each line fires only on a real failure of a rare path (profile change questions), never in a loop.
- **Sensitive data:** the line logs only the error message, never the proposal text or a credential.
- **Rollback:** revert this commit; behavior is identical apart from the log lines.

## Tests
`no-silent-fallbacks` passes at 493. `profile-proposal-placement`, `profile-proposal-requests`, `topicProfileWriteSurface` (68 unit tests in all) and `topic-profile-routes` (35 integration tests) all pass. The type check is clean.
