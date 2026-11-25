# Side-Effects Review — Promises are kept before their time

**Version / slug:** `promise-keeping-before-the-deadline`
**Date:** `2026-11-18`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

The overdue-promise follow-through (PR 3331) messaged the person first when a promised time passed, then handed the promise to a running session. Justin rejected that on 2026-11-18 (topic 144400): a missed promise is work for the agent, not news for the person, and the late path should be a last resort behind mechanisms that keep promises on time. This change replaces the late batch inside `CheckInReminderReconciler` with a promise-keeping pass (`src/monitoring/promiseKeepingPass.ts`, pure stage logic in `src/monitoring/promiseKeepingCore.ts`):

- a midpoint and a due-soon check before the time;
- a pickup after the time;
- a re-check;
- a fixed-template last resort only when no session could take the work or two pickups produced nothing;
- backoff, then a daily attempt, then a hand-off to the promise review.

Sessions are started through the direct spawn path (`spawnSessionForTopic` with new `systemNotice`, `quiet`, `admissionKind` and `triggeredBy` options), never the inbound message pipeline. The start runtime (`promiseWork`) is built in `src/commands/server.ts` and passed through `AgentServer` to the routes.

The commitment write paths gain three record rules, live only where the check-in gate is live (`src/monitoring/promiseKeepingGate.ts`):

- a given time moves only through the new `POST /commitments/:id/reschedule`, which sends the message and moves the time once delivery is confirmed (an outcome still unknown after 30 minutes is treated as delivered, since the transport says not to resend);
- past its time, deliver needs `deliveryMessageId`;
- forwarded PATCH and deliver get the same rules at the owner (`src/core/CommitmentMutation.ts`): the owner runs the same message-history check the local deliver route runs.

The promise review gains `set-time` and `pick-up` actions, a closing line when it retires a promise whose last resort was sent, and parked rows at the front of its queue. Promised-update reminders pick the work up before any line to the person. The awareness entry and the promise-review job prompt are rewritten. The dead late-notice code in `lateNoticeCore.ts` is removed.

Files: `src/monitoring/{promiseKeepingCore,promiseKeepingPass,promiseKeepingGate,promiseHandoff,CheckInReminderReconciler,CommitmentTracker,PromiseReview,lateNoticeCore}.ts`, `src/core/CommitmentMutation.ts`, `src/server/{routes,AgentServer}.ts`, `src/commands/server.ts`, `src/data/awareness/overdue-promise-follow-through.md`, `src/scaffold/templates/jobs/instar/promise-review.md`, tests.

## Decision-point inventory

- Stage of a promise (check / pickup / last resort / parked) — modify — deterministic predicate over record fields (`promiseKeepingCore`).
- Pickup outcome (notified / started / held / failed) — add — transport answers; held and failed are retried.
- Last-resort message — modify — was the first step, now the last; a fixed template that never asks the person to act.
- Session start for promise work — add — lease holder only, the shared automatic-start gate, below `maxSessions`, a third of `maxSessions` working, 3 per pass.
- Session release for finished promise work — add — every clause must be known and hold.
- PATCH of a given time / deliver past the time — add — refusals with a plain error naming the operation to use, gate-live only.
- Promise review `set-time` / `pick-up` — add — non-closing, evidence floors.

---

## 1. Over-block

- A session that legitimately wants to move a time silently (the result is truly minutes away) is refused a plain PATCH. It has the one-off 15-minute grace, and otherwise must tell the person through reschedule. That is intended: a given time never moves without the person knowing.
- A session that delivered the result somewhere other than the promise's own conversation (for example a different topic) cannot deliver the overdue row without a message id from that conversation. It can send a one-line pointer there and cite it. This is accepted friction.
- A deliver whose message is older than the conversation cache covers is refused (unknown is treated as not found). A rare edge, and it fails toward "send the result again".
- A reschedule from a non-owner machine is refused with the owner named.
- The deliver rule applies only to Telegram conversations (`topicId > 0`); Slack or topic-less promises deliver as today, since there is no history to cite.

---

## 2. Under-block

- Promises owned by a standby machine with no session there are only partly covered: the start is held as not-holder, then the honest `not-here` last resort follows. This is tracked as fb-e2a65da1-b42.
- Slack conversations are excluded from every stage (fb-baf17cfd-85f).
- `deliveryMessageId` proves the person received an agent message after the promise was made, not that the message is the result. That judgment stays with the session.
- A session can keep rescheduling with told messages without a cap. Each move reaches the person, and the promise-notice backstop (6 per conversation per 10 minutes) bounds the rate.

---

## 3. Level-of-abstraction fit

The pass lives where the reminder pass already ran (one 5-minute tick, one speaking machine per row) and reuses existing primitives:

- `spawnSessionForTopic`, the same direct path the beacon revive uses;
- the shared automatic-start gate (`interactiveSpawnCapacity` plus work admission);
- the existing promise-notice send, with its envelope, dedup and origin-service automation reply;
- the promise review's evidence-checked apply route, rather than a new triage job.

The stage decision is pure and separate from the I/O.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

The pass blocks nothing. It produces work for sessions and, rarely, one fixed message. The two write refusals are structural validation of a record write, not a brittle classifier: each refusal names the exact operation that succeeds instead (reschedule, or deliver with a message id), applies only while the gate is live, and is lifted by the one live rollback switch. The release rule ends sessions only under all-known conditions on sessions this feature started.

## 4b. Judgment-point check (Judgment Within Floors standard)

The one competing-signals point, what to do with a picked-up promise, is the session's judgment within a floor: deliver; keep working; one told reschedule; withdrawal only on the person's own words. The fixed counts (2 pickups, 3 failed starts, backoff then daily, the 7-day hand-off) only delay the one irreversible step, the last-resort message. They are named constants and are read against the pass report during the 7-day dev soak. The spec's decision table classifies each.

---

## 5. Interactions

- **PromiseBeacon:** unchanged and independent (its user output stays off).
- **ResumeQueue:** a topic it owns is `held: resume-queue-owns`, so the two never double-start.
- **SessionReaper:** unchanged. Promise-work sessions are tagged with `triggeredBy: promise-work:…`, and the pass releases its own finished ones after its own guards, including the protected list.
- **CommitmentSentinel:** a pickup message with no new person message forms no pair, and the bootstrap tells the session to update the existing record.
- **Quiet by Default:** the last resort, the reschedule message and the closing line all go out under the promise-notice envelope, and a quiet receipt counts as not delivered.
- **Promise review:** it sees parked rows first. Its closures stay shadowed by `closureDryRun` where configured, and `set-time` and `pick-up` are non-closing.

---

## 6. External surfaces

- New route: `POST /commitments/:id/reschedule`.
- Changed: `PATCH /commitments/:id` refuses a given-time move (409, `refusedBy: promise-keeping-given-time`); `POST /commitments/:id/deliver` past the time needs `deliveryMessageId` (409, `refusedBy: promise-keeping-deliver-evidence`). Both apply only where the check-in gate is live; dark agents keep today's behavior.
- The check-in pass report's `late` block changes shape to `{ran, wouldAct, dueIds, keeping}`.
- Person-facing: the old "These were due and aren't marked done" list is gone. The new last resort is rarer and never asks anything.
- Agent-facing: a new system notice `[instar promise follow-through — …]`, the awareness entry, and the review prompt.
- No new config keys.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface (dashboard, approval page or form) is touched.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

- **Commitment rows:** single-writer (the creating machine), read-replicated through `CommitmentsSync`, unchanged. Rows whose owner and origin differ are skipped and counted.
- **One voice:** only the speaking machine acts on a row, and only the lease holder starts sessions.
- **Start limits:** read the starting machine's own pool. machine-local-justification: physical-credential-locality (a session runs on one machine's Claude login and tmux).
- **Status surfaces:** the check-in pass report (`POST /commitments/check-in-reminder/pass` and the ticker's report) is per machine, as before.

---

## 8. Rollback cost

`commitments.checkInReminder.dryRun: true` is read live. It stops every notice, start, stamp and send the pass makes, and it lifts the PATCH and deliver rules, with no restart. A revert restores PR 3331's behavior. Old code ignores the new fields; the old `lateNoticeFor` keeps its meaning ("the person was told"). No data migration and no config migration.

## Conclusion

The change does what Justin asked: keeping promises is now the main mechanism, and the person-facing late message is the rare last resort. Six spec-review rounds (internal reviewers plus GPT-tier and clean-door external reads) shaped the start path, the record rules and the bounds. The remaining risks are the tracked standby and Slack gaps and the fixed counts, which the dev soak will tune.

## Second-pass review (if required)

**Reviewer:** second-pass subagent (independent)
**Independent read of the artifact:** concur (after re-check; original read was concern)

1. BLOCKING — `src/monitoring/promiseKeepingCore.ts:205-209`: the reason-agnostic deadline fires with zero attempts. Any row whose time passed more than one re-check interval ago, with no pickup yet, goes straight to the last resort with no pickup. This covers backlog rows inside the 24 h window on the first live pass after a dry-run flip, and rows that passed during server downtime. Because `variantForNotTaken({}, 0)` returns `could-not-restart`, the person is told "Restarting the work failed." when nothing was tried. The fix: require at least one recorded attempt for this generation, or measure from max(T, epoch, first attempt).
2. BLOCKING — `src/monitoring/promiseKeepingPass.ts:162-167` with `:323`: a timed-out pending attempt frees its slot, because the pending count filters out `timedOutAt`. That contradicts the code comment at :163 and spec §3.1 ("slot stays reserved until settlement"). After the last resort, the timeout path also does not advance `nextAttemptAt`/`backoffStep`, so a parked row whose spawn hangs is relaunched every pass (about 5-10 min) rather than on backoff or daily. Result: unbounded hung starts.
3. BLOCKING — `src/server/routes.ts:40409` and `src/monitoring/promiseKeepingCore.ts:326`: the deliver-evidence rule has no topic check. A past-time row in Slack, with no topic, or on another surface has no Telegram history, so every deliver is refused and the row cannot be delivered. Section 1 (Over-block) does not mention this.
4. BLOCKING (artifact false) — `src/core/CommitmentMutation.ts:101`: the forwarded deliver only checks that `typeof deliveryMessageId === 'string'`. Any string passes, with no history check. A numeric Telegram id (what sessions send, and what the local route forwards unchanged) is refused. The claim in Summary/§4 that "forwarded … deliver get the same rules at the owner" is false.
5. NON-BLOCKING — `promiseKeepingCore.ts:123-146`: `preDeadlineCheck` has no `attempt-pending` guard. A midpoint or due-soon start that is still pending is relaunched on the next pass, and its `pendingAttempt` is overwritten, which risks a double start. Failed pre-deadline checks also add to the overdue `failedAttempts` for the same generation (`countFailed`), so the overdue ladder can reach `could-not-restart` early.
6. NON-BLOCKING — `CheckInReminderReconciler.ts:336-345`: a promised-update pickup uses `mayStart: true`, which bypasses the 3-per-pass budget and the third-of-maxSessions limit. It also stamps `pending` as handled and has a no-op `onSettled`, so a failed spawn is silently dropped and nobody is told.
7. NON-BLOCKING — `promiseKeepingPass.ts:210-216`: the parked-start cap is per pass, not per day as in spec §5/the decision table. Each row is still daily.
8. NON-BLOCKING (artifact imprecise) — `routes.ts:39121`: an unknown delivery older than 30 min is treated as delivered and the time moves. The Summary's "moves the time on a confirmed delivery" overstates this.
9. NON-BLOCKING — `PromiseReview.ts:593-601`: the closing line is sent once on a best-effort basis (a failure is only logged), and its text includes the LLM-written `d.reason`, so it is not a fixed template.

Checked and sound: the gate is live only with `enabled !== false && dryRun === false` (dark agents are unaffected). `spawnSessionForTopic` with `systemNotice` skips the "user's latest message" framing and the `[telegram:N]` prefix, and `quiet` suppresses the profile notices. Pickups are launched and never awaited. The release rule needs the promise-work tag, not protected, and a known `personWroteSince === false`. Last-resort sends are once per time via `lateNoticeFor`, with backoff ×2/×4/×8 then daily.

**Resolution (author, same day):**
1. Fixed: the "not taken in time" trigger now needs at least one recorded attempt and counts from the FIRST attempt (`firstHeldAt`, set for held and failed), so a backlog or downtime row is always tried first. With no failures the variant is `queued`, never "Restarting the work failed". Tests: `promise-keeping-core.test.ts` "a backlog row … is TRIED first".
2. Fixed: a timed-out pending start keeps its slot and holds its row for `PENDING_SLOT_HOLD_MS` (30 min) more, so it is neither counted free nor overwritten by a retry (`attemptStillHeld`), and a timeout after the last resort advances the backoff (`backoffIfParked`). Test: "a timed-out start keeps its slot".
3. Fixed: the deliver rule applies only where `topicId > 0` (`isOnOverduePath`). Test: CommitmentMutation "a Slack promise past its time can still be delivered".
4. Fixed: the owner runs the same history check through `verifyDeliveryMessage` (wired in server.ts with the topic history and `anchorMs`), accepting a numeric or string id. Test: CommitmentMutation "a forwarded deliver past the time gets the SAME message check".
5. Fixed: pre-deadline checks skip a held pending attempt, and their failures and holds no longer count toward the overdue ladder. Test: "a failed pre-deadline check does not count toward the overdue ladder".
6. Fixed: promised-update starts respect the third-of-maxSessions limit, and a launched start is not stamped as handled; the next pass confirms it or counts another attempt toward the last resort.
7. Fixed: parked starts are capped per 24 hours machine-wide (counted from parked rows picked up in the last day).
8. Artifact corrected (Summary).
9. Accepted as is: the closing line is a fixed frame ("I've stopped working on "…": <reason>"). The review's reason is a required plain-language field the job prompt asks to be readable by a person, and a failed send is logged, not retried, because the row is already closed and a retry would need its own outbox. Recorded here as accepted.

**Re-check (second-pass reviewer, same day):** I re-read the code. Fixes 1-8 are real, tsc is clean, and the 5 touched unit files pass (112 tests). The `firstHeldAt`-anchored deadline needs an attempt and defaults to `queued`. `attemptStillHeld` plus the 30-minute slot hold, and `backoffIfParked` on timeout, bound a hung start to about one relaunch per 35 minutes per row before the last resort, then backoff. `isOnOverduePath` skips rows with `topicId <= 0`. The owner deliver runs the same `agentMessageSince` check through `verifyDeliveryMessage` for a numeric or string id. Promised-update pickups no longer stamp `pending` as handled. Item 9 is accepted. Two residues, both NON-BLOCKING:
- `promiseKeepingPass.ts:166`: the timeout reconcile still calls `countFailed` (and sets `firstHeldAt`) for a timed-out midpoint or due-soon check, so item 5 is fixed only for settled outcomes. It should be gated on `pa.stage === 'overdue'`.
- `CheckInReminderReconciler.ts:344-348`: a promised-update start that keeps coming back `pending` (for example a started session that dies) adds an attempt each pass. At `CHECK_IN_MAX_ATTEMPTS` (5) the row leaves the due set without a last resort or `checkInReminderFailedAt`. That is a silent stop, bounded at 5 starts. `mayStart` also ignores in-flight starts (no pending record).

**After the re-check (author):** both remaining non-blocking gaps are closed. A timed-out midpoint or due-soon start no longer counts toward the overdue ladder (`promiseKeepingPass.ts`, reconcile path gated on `pa.stage === 'overdue'`). A promised update whose start keeps coming back pending reaches the last resort on its third attempt instead of dropping out silently after five (`CheckInReminderReconciler.ts`).

## Evidence pointers

- Spec: `docs/specs/promise-keeping-before-the-deadline.md` (converged in 6 rounds, report `docs/specs/reports/promise-keeping-before-the-deadline-convergence.md`).
- Unit: `tests/unit/promise-keeping-core.test.ts` (47), `tests/unit/promise-keeping-pass.test.ts` (19), `tests/unit/promise-handoff.test.ts`, `tests/unit/late-notice-reconciler.test.ts`, `tests/unit/PromiseReview.test.ts`, `tests/unit/CommitmentMutation.test.ts`, `tests/unit/promise-notice-delivery.test.ts`.
- Integration: `tests/integration/overdue-promise-follow-through-routes.test.ts`.
- E2E: `tests/e2e/overdue-promise-follow-through-alive.test.ts`.

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `unbounded-self-action`
- **`closure`** — `guard`
- **`guardEvidence`** — enforcement `ratchet`, citation `tests/unit/self-action-convergence.test.ts` (controller `promise-keeping-pickup` in `src/testing/selfActionRegistry.ts`, modeled with the real `overdueStep` and `nextBackoffAt`).
- **howCaught** — Control-loop edge: the 5-minute check-in pass starts or notifies a session for an overdue promise. Steady-state bound: under the worst case (every start fails, the record never moves), at most 3 failed starts, one last-resort message per promised time (stamped `lateNoticeFor`), then backoff ×2/×4/×8 of the re-check interval, then one start a day, which the ratchet pins as an eternal sentinel with a 12-hour rate floor. Settling brake: the attempt and backoff stamps on the commitment row, which survive restarts, plus the per-pass and third-of-maxSessions start limits and the 7-day hand-off to the promise review.
