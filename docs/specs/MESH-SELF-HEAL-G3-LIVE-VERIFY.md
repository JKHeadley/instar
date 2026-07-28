# G3 Live-Verify — Test-as-Self over Telegram (the FINAL gate)

> Per the constitutional standard **"Live-User-Channel Proof Before Done"** + Justin's explicit 2026-06-27 directive: drive every scenario AS the user, through the REAL Telegram surface, on the REAL two-machine pair — BEFORE claiming done. Synthetic tests gave false confidence today; this pass is mandatory. Produces a signed PASS/FAIL matrix.

## Preconditions
- [ ] Full unit suite green (commit gate) + G3.1–G3.5 committed via /instar-dev.
- [ ] Test-as-self Telegram login live in the Mini's Playwright profile (set up 2026-06-27 ~15:16 PDT — re-verify the session is still authenticated in-browser before relying on it; login state is last-asserted, advisory).
- [ ] Both machines online + heartbeating (`GET /pool` — both selfReportedLastSeen current). For the two-machine scenarios the Laptop must be awake and participating; if it is dark, the two-machine duplicate scenario can't run (note it, don't fake it).
- [ ] A throwaway TEST topic created (NOT any of Justin's real conversation topics). All destructive scenarios (kill, forced failure) run THERE. Real threads are never disrupted.
- [ ] Feature toggled for the test: `multiMachine.sessionPool.ownershipCheckedSpawn = { enabled: true, dryRun: false }` on BOTH machines (verify ENFORCEMENT, not just observe). Record prior state; restore to the agreed end-state after the pass. Restart sessions/server to apply (config is read at session start).

## Scenario matrix (drive each AS the user via the Mini's Telegram browser; record PASS/FAIL + evidence)

| # | Risk category | Scenario | PASS criterion | Evidence to capture |
|---|---|---|---|---|
| 1 | Happy-path | Send a normal message to the TEST topic | Exactly ONE session answers; one reply arrives; no second copy | `GET /sessions` shows one session for the topic; one Telegram reply; `/mesh-selfheal/g3` summary shows spawnedAsHolder++ |
| 2 | Lifecycle (binding-IFF-live) | Kill the test topic's session mid-thread, then send another message | Killed session does NOT resurrect; a FRESH session spawns; conversation preserved (reply references prior context via --resume) | reap-log entry; `logs/mesh-selfheal.jsonl` `binding-cleared`; new tmux session name ≠ old; reply shows continuity |
| 3 | Failure / the core bug | Recreate this-morning's setup: get both machines to have/attempt a session for the same topic | Only ONE machine serves; the non-holder FORWARDS (or refuses to spawn); zero duplicate replies | `/mesh-selfheal/g3` forwarded++ on non-holder; one reply only; both-machine `/sessions` shows one owner |
| 4 | Channel-parity | (If applicable) confirm the same behavior holds on the lifeline/system topic path | Consistent single-serve behavior | reply + `/sessions` |
| 5 | Idempotency | Send the same message twice rapidly to the test topic | One logical handling; no duplicate session, no double reply (existing dedup + the gate) | one reply (or dedup-suppressed); `/sessions` one session |
| 6 | Concurrency | Two near-simultaneous inbounds to the test topic across the pair | No split-brain double-serve; one owner | `/pool/placement?topic=N`; one reply per message from one owner |
| 7 | Failure / rollback | Set the flag back OFF and repeat #1 | Legacy behavior intact (still single-serve via existing paths); no regression from the toggle | reply; `/sessions` |
| 8 | Regression | Confirm a normal real-topic message (Justin's own) still flows after the test | No disruption to real threads | Justin confirms a real reply lands |

## Honesty rules during the pass
- Record what each scenario ACTUALLY showed — pass OR fail. A surprise is a finding, not a thing to paper over.
- If the Laptop is dark, scenarios 3/6 (two-machine) are BLOCKED — say so; do not simulate a second machine and call it live.
- The destructive scenarios run on the TEST topic only. Never kill/force-fail on Justin's real conversation topics.
- The test-as-self login is logged into Justin's personal account — use it SOLELY to drive these scenarios; do not read or act in his private chats.
- After the pass: restore the flag to the agreed end-state (recommend: leave ENABLED on the pair if all green, since the whole point is to stop the drops — confirm with Justin), and report the full matrix.

## North-star
Operator-found escapes → zero. If Justin hits a defect after this pass passes, that's the process failure to learn from.
