# Side-effects: message activity stops adding permanent graph records

## Summary

Each conversation's inventory row is a permanent signed record that a machine removal has to carry. The row included last activity, so each new message caused a new record at the next scan, and each machine also wrote a checkpoint every hour. Echo's own Telegram log shows about 3,000 to 5,800 messages a week across 10 to 100 topics. At that rate the 20,000 record limit could be reached within weeks, before any size limit on bytes. Reads and removal slow as records grow.

Now a new record comes only from a real change to the row (title, id, machine, platform), the first activity time, or an activity time more than a week behind. The checkpoint heartbeat is daily, and coverage counts as stale after three days instead of three hours. This machine's live activity is kept in memory and used for ordering only, so the list stays in order without a record.

Decision point: none. Coverage staleness still only marks the read partial.

## 1. Over-block
No issue identified. Nothing is refused.

## 2. Under-block
Records still grow slowly: about one per topic active in a week, plus two checkpoints a day for two machines. No compaction exists yet, so the limit is reached in years rather than weeks. A machine that silently stops publishing now shows stale coverage after three days rather than three hours. Its rows stay readable either way.

## 3. Level-of-abstraction fit
The comparison already decided when a new record is written, so the change sits there. Live activity lives in the runtime next to the read it serves, and is filled by the same scan.

## 4. Signal vs authority compliance
Follows `docs/signal-vs-authority.md`: no blocking authority added. Live activity affects ordering and the displayed freshness only. It adds no conversation, and it cannot raise anything except a time already present.

## 5. Interactions
Conversations on another machine order by their signed time, at most a week behind. The checkpoint cadence test still passes against the new constant. The self-action registry wording moved with it. Live activity is lost on restart and refilled by the next scan, and a new runtime after a removal starts empty and refills the same way.

## 6. External surfaces
List order on the machine serving the page stays live. Order for another machine's conversations can lag by up to a week. No route or wire format change: rows keep the same fields.

## 7. Multi-machine posture
Signed rows replicate as before. Live activity is machine-local by design: it is ordering data each machine reads for itself.

## 8. Rollback cost
Revert the commit. Records written so far stay valid and nothing needs repair. Nothing is deployed yet, so no agent carries the old growth.

## Class-Closure Declaration
Defect class: unbounded-self-action. Closure: bounded. Activity no longer drives permanent records; the remaining rate is one per active topic a week and one checkpoint per machine a day. Long-term compaction remains absent and is stated above.

## Evidence
Message and topic counts came from Echo's own Telegram log. Tests: `tests/unit/graph-source-row-unchanged.test.ts`, a new integration case proving a new message reuses the record and a rename adds exactly one, and `tests/unit/conversation-graph-source-sweep-cadence.test.ts`.

## Second-pass review
Not required: no session, gate or message decision touched. The real-pair measurement follows in the next commit.
