# A promised time is watched

<!-- bump: patch -->

## What Changed

When an agent records a promise to its person with a target time (`softDeadlineAt`) and that time passes with the promise still open, the person now gets one plain message in the same conversation. It says what was promised, the time, and that it isn't marked done. Before this, nothing read that time, so a missed promise was silent.

If the session that made the promise is running, it gets a note 30 minutes before the time and another when the time passes, asking it to deliver, or to say why it is late and give a new time. A session that is not running is not restarted.

The messages are bounded:
- one per promised time, and three per promise in all;
- one per conversation per hour;
- 3 conversations per check, and 12 per hour.

Automatic deadlines worked out from words like "soon" are ignored, and so are promises waiting on the person.

`POST /commitments` now answers with `dateMissing` when the promise's words name a time ("by noon") but no target time was set. Setting a target time clears a "no follow-through needed" reason, and age-expiry waits for a future target time.

It rides on the dated check-in reminder: live on development agents, and off by default elsewhere until `commitments.checkInReminder.dryRun` is false.

## What to Tell Your User

- **Missed promises are no longer silent**: "If I tell you something will be done by a time and that time passes without it, you'll get one short message saying so, and I'll come back with where it stands and a new time."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Late notice for a missed promised time | Record the promise with `softDeadlineAt`; the check-in reminder pass does the rest |
| Ask for a missing date | `POST /commitments` returns `dateMissing` with a suggested `softDeadlineAt` to PATCH |

## Evidence

- Unit:
  - `tests/unit/late-notice-core.test.ts` (63);
  - `tests/unit/late-notice-reconciler.test.ts` (24, including a 200-row burst across 50 topics);
  - `tests/unit/promise-handoff.test.ts` (10);
  - `tests/unit/CommitmentTracker-auto-expiry.test.ts` (+2).
- Integration: `tests/integration/overdue-promise-follow-through-routes.test.ts`.
- E2E: `tests/e2e/overdue-promise-follow-through-alive.test.ts`. A real server timer delivers one late notice, leaves a backlog promise alone, and spawns no session.
- Spec: `docs/specs/overdue-promise-follow-through.md`, converged in 3 rounds with a codex cross-model review.
