# life-distributable: first review, 2026-11-01

Repo: `mattabate/life-distributable`, read at its head on 2026-11-01. Paths under `hub/internal/` are shortened to `hub/`.

**Status: unreviewed candidates, not recommendations.** These came from one reader's deep dive, before the pipeline in
`docs/specs/ecosystem-idea-pipeline.md` existed. The operator has already cautioned against item 1. The first pipeline run
treats them as ordinary candidates.

| # | Idea | Their evidence | Note from the first pass |
|---|---|---|---|
| 1 | Context byte budget | `threads/preamble_test.go:51-61`, a test failing over 12,000 bytes | Operator: earlier research found little reduction possible without quality loss. Takes something away |
| 2 | A session is not the operator | `server/sessionlimits.go`, `actions/decider.go`; `ADDENDA.md` add-0109, add-0048 | Instar records a session's `PATCH /attention` close as `closedBy: operator` (`src/messaging/TelegramAdapter.ts`), confirmed by reading |
| 3 | Jobs reading outside input get no write tools | `ops/schedule.json`, `sched/sched_test.go:81` | Adds a limit, so it must name the rule that requires it |
| 4 | Advice closes when its effect is measured | `recs/recs.go:17-24` | Their scoring is self-reported |
| 5 | A silent turn gets re-run | `threads/retry.go:139-183` | `src/monitoring/PresenceProxy.ts` detects this and stops, confirmed by reading |
| 6 | Asks carry a machine-checkable done test | `threads/asks.go:36` | No quality data found on their verifier |
| 7 | Queued work learns what changed | `threads/changed.go:18-26` | Gap claim rests on name searches only |
| 8 | Model policy by trigger, with caps and a preflight | `spend/policy.go`, `budget/budget.go`, `threads/preflight.go` | Partly exists; some of it reduces |
| 9 | Backups proven by a real restore | `SETUP.md:246-252`, add-0091, add-0092, add-0057 | Gap claim rests on name searches only |
| 10 | Small hardening set: route-to-doc test, hidden characters in approvals, cut-off means uncertain, setup's closing question | `server/server_test.go:1255`, `actions/actions.go:508`, `:213`, `:466` | Delivery already has effect-unknown; agent-run commands do not |

Where the first pass found the project weaker: its gate is cooperative unless `session_user` is on (`ops/schedule.json`), `<untrusted>` is prompt text with no code applying it,
the repo has 69 commits and began 2026-10-06, and it serves one owner on one Mac. Ideas are worth reading, and are not proven by being there.
