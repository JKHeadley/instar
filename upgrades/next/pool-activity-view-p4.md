# Pool-wide parallel-work awareness (P4) — the last phase of the coherence initiative

## What Changed

The "what are all my hands doing?" view now sees ALL machines: ask
`GET /parallel-work/activities?scope=pool` and every machine's activity
appears in one list — local rows live-accurate, remote rows derived from
the already-replicated coherence journal with honest staleness labels and
named absences (a remote topic's description text stays on its machine by
design; the row says so instead of guessing). When the SAME conversation
shows running on two machines, the view flags the pair — and recognizes
the routine settling window after a deliberate move so it doesn't cry
wolf on every transfer.

## What to Tell Your User

Ask any machine what you're working on across ALL machines and it
answers in one list — including flagging the should-never-persist case of
one conversation active in two places at once.

## Summary of New Capabilities

- `GET /parallel-work/activities?scope=pool` — the pool-wide view
  (default scope unchanged).
- `src/core/PoolActivityView.ts` — the per-instance replica fold with
  overlap + recentMove + lowConfidence honesty.

## Evidence

5 unit tests incl. the B-terminal-never-masks-A aggregation and the
remote↔remote overlap pair; typecheck/lint green.
