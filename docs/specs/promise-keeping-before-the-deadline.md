---
title: "Promises are kept before their time; a miss is picked up, and the person hears only on delivery or as a last resort"
slug: "promise-keeping-before-the-deadline"
author: "echo"
status: "draft"
created: 2026-11-18
parent-principle: "The Agent Carries the Loop"
sibling-principles: "Structure beats Willpower; Close the Loop (Untracked = Abandoned); Bounded Notification Surface; Self-Heal Before Notify; Verify the State, Not Its Symbol; No Unbounded Loops"
lessons-engaged: "missed-promise-pick-up-not-report (Justin 2026-11-18); cross-boundary work must name its owner and handoff; spawn-storm caution from the beacon boot cap; inbound-pipeline side effects named in overdue-promise-follow-through §3.3"
supersedes-in-part: "overdue-promise-follow-through.md §2 (a missed promised time is told to the person first) and §3.2–§3.3 (send, then hand off to a running session only)"
origin: "Justin, topic 144400, 2026-11-18 12:11 PT, on the late message 'These were due and aren't marked done': the agent's job is to pick things up and do the work, not tell the user what failed or was forgotten; notify as little as possible; on a critical miss say it was missed and exactly what is being done to move forward. 12:14 PT: all of this should be a last-resort mechanism; more important is robust mechanisms so an agent does not miss promises or deadlines and actually meets them."
eli16-overview: "promise-keeping-before-the-deadline.eli16.md"
approved: true
approved-by: "Justin, Telegram topic 144400, 2026-11-18 13:38 PT: \"Approved\" (in reply to the design summary and plain-English overview sent 12:59 PT)."
review-convergence: "2026-11-18T20:44:10.275Z"
review-iterations: 6
review-completed-at: "2026-11-18T20:44:10.275Z"
review-report: "docs/specs/reports/promise-keeping-before-the-deadline-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 7
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Promises are kept before their time

## 1. Problem (measured on Echo's lease holder, 2026-11-18 ~20:20Z)

The late-promise feature (PR 3331, `overdue-promise-follow-through.md`) went live today. When a promised time passed, it messaged the person first ("These were due and aren't marked done: ...") and handed the promise only to a session that was already running. Justin rejected that: it hands the person a list of what slipped. The agent should pick the work up and do it. He also said the late path should be the last resort, and the real goal is to keep promises before their time.

Today's numbers:

- 503 open promises. 36 carry a promised time (`softDeadlineAt`); 467 carry none, so nothing notices when they slip.
- 370 open promises sit in 67 conversations with no live session anywhere in the pool. A promise whose session ended has nothing working on it.
- The only pre-deadline step is a 30-minute "due soon" notice, it reaches only a running session, and it is stamped before the handoff, so a failed handoff is never retried.
- After the late handoff, nothing checks that the work was delivered.
- The promised-update reminder ("I said you'd have my next update ... and I haven't sent it") also tells the person first.
- The beacon's own session revival (`requestRevive`, `src/commands/server.ts` ~19870) can never fire: it detects a lost session through a `sessionEpoch` nothing stamps, and it sees only the 20 beacon rows the boot cap leaves on.

## 2. Decision

A missed or at-risk promise is **work for a session, not news for the person.** The person hears:

1. the result, from the session, when the work is delivered;
2. from the session, if it must move the time it gave: what was missed, what it is doing, and the new time (the person was given a time, so a moved time is told, never silent); or
3. as a last resort, when the agent could not get the work restarted, one message saying what was missed, why, and what the agent keeps doing. It never asks the person to do anything.

## 3. Design

Everything runs in `CheckInReminderReconciler` (one pass every 5 minutes; it is built in `routes.ts`, and `spawnSessionForTopic` from `server.ts` reaches it through a new `ctx.spawnPromiseWork` the server sets at boot, the way other server-owned spawners are exposed) for Telegram conversations only (`topicId > 0`; Slack conversations are excluded from every stage, as they effectively are today, and their coverage is tracked as fb-baf17cfd-85f), for rows whose speaking machine (`ownerMachineId ?? originMachineId`) is this machine and whose `originMachineId` is this machine (ids are per-machine counters, so a row is only ever mutated by its creator; `CommitmentsSync` is read-only replication). Today `ownerMachineId` is stamped by the creating machine at creation and never changed, so the two agree on every row; a row where they ever differ is skipped and counted in the pass report rather than handled by two machines or none silently.

### 3.1 The pickup function and its typed outcome

`pickUp(topicId, bootstrap)` returns one of:

- `notified` — a session for the topic is live on this machine and the paste-notification inject returned `submitted` or `queued-busy` (as today).
- `started` — no live session; this machine started one with `spawnSessionForTopic` and the awaited call returned a registered session name. This is the beacon-revive spawn path, not the inbound message pipeline, so the inbound side effects never run (no "Session starting up" line, no admission or cold-start notices, no Chief of Staff or memory-privacy refusal, no topic-history row). Three new `spawnOpts` make the direct path itself safe for this use:
  - `systemNotice` — the bootstrap goes into its own block, the way `carriedBrief` does, never as "The user's latest message: [telegram:N] …". Without this the session would read the notice as the person's message and its standing rule would acknowledge it to the person.
  - `quiet` — the topic-profile fallback notices `spawnSessionForTopic` can send to the topic (`sendToTopic`, ~1872) are skipped for this start.
  - `admissionKind: 'automatic'` — the start is admitted as an automatic start, so it never takes the host-wide recovery slot reserved for the operator's own session when the machine is overloaded (today the direct path defaults to `'operator'`).

  The session record carries `triggeredBy: 'promise-work:<CMT-n>:<attemptId>'`. `spawnSessionForTopic` does not pass `triggeredBy` or `admissionKind` to `spawnInteractiveSession` today (`server.ts` ~1981–2005), so both are new plumbing. `buildHandoffContinuationInstruction` is skipped for these starts (see No generic continuation below).
- `held` with a reason — the start was not attempted because: this machine is not the lease holder (`not-holder`); `SessionManager.interactiveSpawnCapacity(admission)` refused (`capacity`, the same absolute cap and overload check every automatic start obeys); the ResumeQueue already owns the topic (`resume-queue-owns`); or the promise-work concurrency limit is reached (§3.6).
- `failed` with the error — the inject threw, or the spawn threw or returned no session.

`started` is the corroborated state that a session was registered for the topic. The pass never waits on a spawn: it writes the attempt (below), launches the spawn, and moves on; the spawn's result is recorded on the row when it settles, so a spawn that never settles cannot stall the reminder pass. It does not prove the session read the notice: a session that dies at boot is caught by the next stage or the re-check, which is the bounded cost of trusting registration.

**Crash safety.** Before a start, the attempt is written as `pendingAttempt = {id, stage, at}` (one per row). The session record carries `triggeredBy: 'promise-work:<CMT-n>:<attemptId>'`. A pending attempt is resolved by its own result when the spawn settles; if it is still pending on a later pass, it is reconciled against the session registry **including sessions that already exited** (the registry keeps ended sessions with their `triggeredBy`; a test pins that retention, since this recovery depends on it): one carrying that attempt id → `started`; none after 5 minutes (`PENDING_ATTEMPT_TIMEOUT_MS`) → `failed`. A crash before the spawn costs one retry; a crash after it, or a session that started and exited between passes, is recognized. Starts go through `spawnSessionForTopic`'s locked entry point, which serializes starts per conversation, and a start is never dispatched while any session is bound and alive in that conversation, so a timed-out spawn that completes late binds the conversation and the retry sees it instead of starting a second session. A pending attempt counts against `PROMISE_WORK_MAX_LIVE` until it resolves, so outstanding starts reserve their slot.

**Generations.** Every attempt carries the promised time it was made for (`gen = softDeadlineAt` at dispatch, or `pickupRequested` time). A spawn result, a confirmation or a reconciliation is applied only when the row's current time still matches `gen`; a reschedule or delivery that happened while a spawn was in flight makes the late result a no-op on the row (a session it started is then an ordinary promise-work session subject to the release rule).

**Reservations last until settlement.** A pending attempt keeps its slot until its spawn settles. The 5-minute timeout only marks the attempt `failed` for the ladder; the slot stays reserved until the spawn resolves or the session registry shows it never registered after the spawn call returned, so delayed spawns across many conversations cannot exceed the working limit. A spawn that registers after its timeout is accepted as `started` if its generation still matches.

**A live but stuck session.** Before the second pickup, the pass checks the live session's state, not just its output: it did not take the work only if it has produced no output since the first notice AND is idle at its prompt with no running child process (a session in a long tool run or still reasoning is busy, not stuck). If it did not take the work and it is a promise-work session the person never wrote in, it is released and a fresh one is started; if it is a session the person has written in, it is left alone and the attempt counts as `failed`, so the ladder moves on.

**Confirming a start.** `started` is provisional until the next pass sees the session alive or sees output from it; a session that died at boot without output turns the attempt into `failed` and the check is retried. Once confirmed, a check is never re-verified.

**No generic continuation.** A promise-work start passes the bootstrap as its only instruction: the standard handoff continuation (which asks a resumed session to resume every resumable promise and answer any unanswered message) is skipped for these starts, so a midpoint check in a dormant conversation does not reply to stale messages.

### 3.2 The bootstrap a session receives

Every notice, injected or used as a start's first input, is a system notice with explicit provenance:

> `[instar promise follow-through — CMT-n, due <time>, stage <stage>]` This is instar's promise follow-through, not a message from the person. Do not acknowledge it to the person. …

followed by the promise fenced as UNTRUSTED DATA (defanged, clamped, `userRequest` never included), the instruction to read the real record first, and the stage's steps:

- **midpoint / due-soon:** make sure the work is moving and will be delivered by the time; start it now if it is not. Message the person only with the result. If it truly cannot be done in time, tell the person once what is done, what happens next and the new time, and record it (§3.4).
- **overdue:** the person has NOT been told. Do the work now. If it is already done, send the result and close it. Do not tell the person it was late and do not list what slipped. Only if it cannot be finished soon, tell the person once what was missed, exactly what you are doing, and the new time, and record it (§3.4). Update THIS record; do not record a new promise for the same work.

The notices never prompt a withdrawal: deciding a promise is no longer wanted stays the session's ordinary judgment on the person's own words, with no nudge toward it.

### 3.3 Before the time: two checks

For a promise with a promised time `T`, made at `C`:

- **Midpoint check** at `C + (T − C)/2`. It is skipped only when a due-soon check will also run and the two fall within 30 minutes of each other.
- **Due-soon check** at `T − 30 min`, for promises made at least 1 hour before `T` (as today).

So a promise shorter than an hour gets the midpoint check alone, and every promise of at least 10 minutes gets at least one check. `C` is the time the promise was recorded or its time was last moved, so checks after a move are spaced from the move.

A check is stamped (`midpointCheckFor` / `dueSoonNudgeFor` = `T`) when its outcome is `notified` or `started`. `held` and `failed` leave it unstamped and it is retried on later passes while its window lasts (until the next stage begins). A confirmed check is never re-verified: a session that finds nothing to do and is later reaped is not restarted for the same check. Retries per check are bounded by its window and by §3.6, and a check that never got through leaves the overdue stage to act.

### 3.4 Moving the time

A session moves a time it gave the person with one operation, `POST /commitments/:id/reschedule {newTime, message}`. The server sends `message` to the promise's own topic, followed by a line it writes itself from `newTime` ("New time: Wednesday 18 November, 5:00 PM"). It changes `softDeadlineAt` only after that send is confirmed delivered (not held as a quiet notification), and records the message id on the row. The telling and the move are one action, bound to one delivery receipt, so no unrelated message can stand in for it and no move can be silent.

**Crash safety.** The route first writes a `rescheduleIntent {id, newTime, at}` on the row, sends through the Telegram origin service's automation reply with `id` as its operation key (the service records each operation's outcome and replays rather than re-sends a repeated key), and only then moves the time and clears the intent. A crash in between is reconciled on the next pass from that operation's recorded outcome, not from the history cache: delivered → the move is applied; definitively failed → the intent is cleared and the old time stands; pending or unknown → the intent stays open and is checked again next pass. A retry of the same intent never sends a second message, and a second reschedule while an intent is open is refused until it resolves.

- The intent stores the full outbound body and the intent id is passed as the send's `logicalSendId`; the operation id is the origin service's own hash of producer, topic and that id, and its outcome is read through the existing operation-outcome lookup. If no operation exists for the intent (crash before submission), the stored body is submitted again with the same `logicalSendId`.
- While an intent is open the row's stage evaluation is suspended, so no pickup or last resort fires on the old time.
- An intent is resolved within 30 minutes (`RESCHEDULE_INTENT_MAX_MS`): an `unknown` outcome past that is treated as told (Telegram may hold it, and the transport says not to resend), so the move is applied; `partially-delivered` is treated as not delivered; `not-delivered` because the reply check handed it back returns the check's suggestion to the session to revise and resend. The message and the server's "New time" line are one body, kept under one Telegram message.
- On an agent without the origin service, the route sends through the same delivered-or-failed path the last resort uses and gets its answer synchronously; an intent left by a crash there is cleared after 30 minutes and the old time stands.
- The `promise-notice` category's backstop (6 per conversation per 10 minutes) also bounds told moves in practice: past it a send is filed quietly, which the route treats as not delivered. The route lives in `src/server/routes.ts`, the one file the `promise-notice` stamper is allowed in.

The send path is fixed: the route runs `message` through the same outbound check as the agent's ordinary reply route (at minimum `refuseIfCredential`, returning the same 422); sends under the `promise-notice` envelope, so selectivity delivers it rather than filing it quietly; and treats a `QuietReceipt` or `QuietRecordedError` as not delivered, returning a plain error and leaving the time unchanged. When the promise is owned by another machine, the route refuses with a plain error naming that machine, so the session reschedules from there; the send must happen where the row is written (on Echo the lease holder owns 502 of 503 open promises, so this is rare). Forwarded PATCH and deliver mutations get the same record rules at the owner (`applyOwnerMutation`), so no other path bypasses them. `PATCH softDeadlineAt` on a row that has ever had a time (`firstPromisedAt` set) is refused with a plain error pointing at the reschedule operation, whether it sets a new value or clears it; only a row's first-ever time is set by PATCH, which is what the no-time lane asks sessions to do. Clearing then re-setting therefore cannot move a time silently. The refusal lives in the owner's PATCH handler, which forwarded PATCHes also reach, so an older forwarding machine cannot bypass it.

- `firstPromisedAt` keeps the original promised time, set once.
- Moves before the time need no count: each one was told to the person, who can react to it.
- **One short grace, no message.** After a miss, the session may ask once for a grace of at most 15 minutes (`POST /commitments/:id/reschedule {grace: true}`, `SHORT_SLIP_MAX_MS`) when the result is nearly ready. It does not change `softDeadlineAt`: it sets `graceUntil`, during which the re-check waits. It is server-enforced (once per promise, at most 15 minutes), counts toward `timeMovesAfterMiss`, and does not count as the record moving; the person hears once, with the result. A plain PATCH of a given time is always refused.
- `timeMovesAfterMiss` is incremented by the server on every move made after a time already passed (the grace included); nothing resets it, and it is reported per promise in the pass report. There is no cap on told moves: each one reached the person with its new time, so the person already knows and can react; a cap would only replace the session's honest message with a system one.
- A missed time cannot be cleared by PATCH (above); the row keeps `firstPromisedAt` and stays on the overdue path for that time until it is delivered, rescheduled, or withdrawn on the person's own words.
- An accepted reschedule closes the open ladder for the old time (its pickup stamps stay as history) and re-arms the checks for the new time.

**Delivery after a pickup is verified the same way.** For a row on the overdue path, `POST /commitments/:id/deliver` counts as the record moving only when it cites the existing `deliveryMessageId` field (already in the deliver route and its forward payload), and that id is a delivered agent message in the topic sent at or after `C` (so a result sent before the time, with the record left open, still qualifies and is not re-sent). This is delivery evidence, not proof of content: it proves the person received a message from the agent in that conversation; whether that message is the result stays the session's judgment, as with every deliver today. On a row on the overdue path, deliver without it is refused with a plain error ("send the result to the person in this conversation first, then deliver with its id"), so the session that did the work is the one that tells the person, while it is still running. Before each start the pass also checks the record deterministically: a row already delivered or withdrawn is never started.

### 3.5 After the time: pick up, re-check, last resort

The state for one promised time is: `overdue → picked-up → (rechecked) → last-resort-sent → parked`. `held` and `failed` attempts are recorded as a first-held time and counts, written only when they change, so a row held every pass does not rewrite the store every 5 minutes.

1. **Pickup.** At `T`, the session gets the `overdue` bootstrap via `pickUp`. On `notified` or `started`: stamp `pickupFor = T`, `pickedUpAt`, `pickups = 1`. Nothing is sent to the person. These are new fields; the old `lateNoticeFor` keeps its old meaning ("the person was told") and only suppresses a second last-resort message for that time. A row the previous build already told, with no `pickupFor`, is still picked up for the work (its earlier handoff reached only a running session, if any), and a rollback reads only fields it knows.
2. **Re-check.** After the re-check interval (`T − C` clamped to 30 minutes–4 hours: proportional to the promise, `LATE_RECHECK_MIN_MS`/`LATE_RECHECK_MAX_MS`), the record must have moved: delivered, or an accepted time move (§3.4). If not, pick up once more (`pickups = 2`).
3. **Last resort.** One fixed-template message to the promise's own topic, sent when:
   - `pickups` reached 2 and the record has not moved by the next re-check interval (`not-moving` variant: "I picked this up twice and it still isn't done"); or
   - 3 attempts `failed` before the end of the re-check interval in effect (`could-not-restart` variant: "Restarting the work failed"); or
   - no attempt has been taken (`notified` or `started`) by `T` + one re-check interval, whatever the mix of `held` reasons and failures. The variant comes from the most frequent reason: `capacity` → `busy` ("My machine has been too busy to restart the work"); `not-holder` → `not-here` ("Restarting the work needs my main machine, and it could not be started from here"; the closing line for this variant is "I'll keep trying and send the result here when it's done"); `promise-limit` or `resume-queue-owns` → `queued` ("The work is queued behind other restarts and has not started yet"); `failed` → `could-not-restart`.

   Several promises in one conversation that reach the last resort on the same pass go in one message (up to 5 listed, then "+N more"), and the parent spec's caps still bound it per machine: 1 per conversation per hour, 3 conversations per pass, 12 per rolling hour; rows over the cap wait for a later pass. Across machines the bound is 12 × the number of speaking machines per hour; on Echo the lease holder owns 502 of 503 open promises, so in practice it is one machine's 12.

   **Latency to the first word.** Self-heal comes first, so the person's first word about a miss arrives at most `T` + two re-check intervals (at most `T` + 8 hours for a promise of 4 hours or more, `T` + 1 hour for one of 30 minutes), plus any cap delay. A long silence here is deliberate: during it the work is being restarted, and the person hears the result if it lands. A burst test covers 50 conversations reaching the last resort together.

   Text: "I missed the time I gave you (<time>) for this: "<promise>". <variant sentence>. I'm still on it: I'll keep restarting it and send the result here when it's done." For a row the promise review handed over with `pick-up` (§3.7, no promised time), the first sentence is "I haven't finished this yet: "<promise>"." instead, because no time was given. The promise is clamped and defanged the same way as in the notices. The message is stamped with the `promise-notice` category and sent through the same delivered-or-failed send as today, so Quiet by Default cannot file it silently (CMT-1951). `held` attempts never count as failures, so a busy machine is self-healed first and reported only after the bounded latency.
4. **After the last resort** the promise stays open and the agent keeps trying, as the message says. Pickups continue with doubling backoff (re-check interval × 2, × 4, × 8), then settle at **one attempt a day** for as long as the promise is open (`parkedAt` set when the daily cadence begins). Parked rows are queryable (`GET /commitments?parked=1`) and counted in the pass report; they are not put on the Needs-you list, which holds things waiting on the person, and this is not. The rate is bounded: at most one start per day per parked promise, at most `PROMISE_WORK_MAX_LIVE` parked starts per day machine-wide (oldest promised time first, so every parked row is reached in turn), and parked rows are ordered after every unparked row, so they never delay a fresh promise. After 7 days parked the row is also handed to the promise review with `reviewReason: 'parked-unfinished'`; its existing actions decide keep (daily attempts continue), deliver with evidence, or archive with a reason. Because the person was told "I'm still on it", archiving a row whose last resort was sent also sends one fixed line to its topic: "I've stopped working on "<promise>": <the review's reason>." An obligation the agent told the person it would carry never ends silently. A message from the person in the conversation or a move of the record returns it to the normal cadence; the counts are not reset, so the person's message never buys a fresh ladder of messages.

### 3.6 Budget for session starts

Notices into a running session never wait on a budget; several promises in one conversation go as one combined notice per pass. Starts are limited:

- Only the lease holder starts sessions (`_holdsLeaseForSpawn`; on a single-machine agent there is no lease and the machine counts as the holder). A standby's rows get `held: not-holder`; the static-speaker gap is tracked in fb-e2a65da1-b42.
- `interactiveSpawnCapacity` must allow it (absolute cap `maxSessions × 3` plus the overload admission check), the same gate as every automatic start.
- Promise-work sessions that are **working** (output in the last 30 minutes) plus pending starts may number at most `PROMISE_WORK_MAX_LIVE` = one third of `maxSessions`, at least 1 (3 on Echo's 10), so promise work uses at most a third of the normal session room at once; idle ones do not count, because the `maxSessions` floor below already stops idle sessions from crowding the person and the release rule ends finished ones. A session the person has written in since it started no longer counts at all, and a start is allowed only while `listRunningSessions()` (every running session, job sessions included) is below `maxSessions`, so promise work never uses the headroom between `maxSessions` and the absolute cap (`maxSessions × 3`) that the person's own sessions rely on. At most 3 starts per pass.
- **Releasing finished promise work.** The reaper does not reap at normal pressure, so the pass releases its own. A promise-work session is ended with `SessionManager.killSession` (which ends a session unconditionally, so every guard is in the release step itself) only when ALL hold: its promise is delivered, rescheduled or parked; it has been idle at its prompt with no running child process for 30 minutes; the release step's own `protectedSessions` check passes; and the conversation's own history shows no message from the person since the session started, with that history reaching back to the start. If the history does not reach back that far, it is unknown, and the session is not ended. If any of these is unknown, the session is not ended. A session waiting on its own long job is not idle by this definition, and a session the person has written in is the person's conversation and is never ended by this rule.
- Order: each row carries `nextAttemptAt` (set from its backoff after a failed or unproductive attempt). Eligible rows are taken earliest `nextAttemptAt` first, then oldest promised time, so a promise that keeps failing backs off and cannot take every slot from newer ones.

### 3.7 Promises with no time

Two layers, both without messages to the person:

- **Running sessions.** When a session is live in a conversation with untimed open promises, it gets one combined notice per pass (`stage: no-time`) listing up to 5 of them: for each, if it is a promise to the person with a time, set `softDeadlineAt`; if it is done, deliver it with the result. Each promise is asked at most twice, 24 hours apart (`timeAskedCount`, `timeAskedAt`). At most 3 conversations per pass, so a pass writes at most 15 stamps through the ordinary `mutate`.
- **The existing promise review.** The built-in `promise-review` job (every 6 hours, up to 30 open promises per run, decisions applied through `POST /commitments/review/apply` with its server-side evidence floors and per-run and per-day caps) already reads untimed promises, including those in conversations with no live session. It gains two non-closing actions:
  - `set-time` — sets `softDeadlineAt`. The apply route checks that the quoted `evidence` line appears in that topic's own history (`getTopicHistory`) and that the time is at least 30 minutes in the future; otherwise it refuses. Rows given a time this way carry `timeSource: 'review'` and use the no-time last-resort wording, because the review read the time from the conversation rather than the session promising it in the moment.
  - `pick-up` — the work is still owed and no time was given; sets `pickupRequested`, which §3.5 treats as due now with the no-time last-resort wording, a re-check interval of 4 hours (the clamp's ceiling, since there is no `T − C`), and no "not taken in time" trigger: such a row reaches the last resort only through `not-moving` after 2 pickups that actually ran. Requires a reason of at least 8 characters, at most 5 per review run (`PICKUP_PER_RUN_MAX`), and these rows are ordered after every row with a real promised time in §3.6, so they never take a start from a promise the person was given a time for.

  Its existing rules for behavioral and standing-rule rows and for conversations with minted (negative) ids apply unchanged; the running-session lane above takes only one-time-action, agent-owned rows on real conversations and leaves the rest to the review. No new job, no second daily session, and no migration: existing agents already receive the `promise-review` template, and the two actions ride the same apply route.

Capture stays as today (`dateMissing` on `POST /commitments`); the promise review's `set-time` and `pick-up` actions catch the rows capture missed.

### 3.8 Promised updates

The promised-update reminder follows §3.5: the session is picked up first with a promised-update bootstrap (rewritten without "the user was just told"). The person gets a message only through the §3.5 last resort, with its next-step wording, not the old "I haven't sent it" line.

### 3.9 Feedback loops

`CommitmentSentinel` pairs a person's message with the first agent reply after it, past its high-water mark, so a pickup's own "missed, new time" message with no new message from the person forms no pair and records nothing. When the person replies, the existing duplicate check on `userRequest` applies, and the bootstrap tells the session to update the existing record. A unit test asserts on the pairing function that a pickup message alone yields no pair. Promise-work sessions carry `triggeredBy: promise-work:…` so the dashboard can tell them apart; the reaper's rules are unchanged.

### 3.10 Awareness

`src/data/awareness/overdue-promise-follow-through.md` is rewritten: record promises with a time; what each stage's notice asks; the person is never told by the system except as a last resort; moving a time means telling the person; update the existing record rather than recording a new one.

### 3.11 Reading topic history

Three checks read the topic's history: the review's quote check, the delivered-after-pickup check and "the person has not written since". Each reads by time window, not the default last-20 rows: the quote check reads back to the promise's `createdAt`; the other two read back to the pickup or session start. A window the cache cannot cover counts as not found, which refuses the quote and counts the row as not moved: the conservative side in each case.

## 4. What does not change

- Only `softDeadlineAt` is a promised time; `hardDeadlineAt` stays unused here.
- The check-in reminder (a check-in the person asked for) is unchanged: there the message to the person is the deliverable.
- PromiseBeacon is unchanged and independent; its user output stays off.
- Dry-run (`commitments.checkInReminder.dryRun`) stops every send, stamp, notice and start the pass makes, read live. The reschedule route is a session's own action, not the pass's: it works on every agent, and on a dry-run or dark agent the PATCH and deliver rules are lifted, so it is simply an extra option there.

## 5. Safety

- **No person-facing side effects from starts.** Starts use `spawnSessionForTopic` directly with `systemNotice`, `quiet` and `admissionKind: 'automatic'`; the inbound pipeline's notices, refusals and history rows never run, and the direct path's own profile notices are skipped. A test asserts a started bootstrap contains neither "The user's latest message" nor `[telegram:`, and that no `sendToTopic` call happens during a start.
- **Spawn bound.** Lease holder only, the shared automatic-start gate, working promise-work sessions plus pending starts at most a third of `maxSessions` (3 on Echo), 3 starts per pass; the no-time work rides the existing promise-review job, adding no session. The 24-hour backlog window still holds back older overdue rows.
- **Untrusted text.** The promise is fenced and defanged, `userRequest` never included, and the session reads the real record first. The bootstrap states its provenance, so a session never mistakes it for the person.
- **Authority.** A started session receives a system notice carrying no sender; it binds no operator and can approve or grant nothing. Notices never prompt withdrawal.
- **Signal vs authority.** The pass blocks nothing; it produces work for sessions and, rarely, one message. The two refusals in §3.4 (PATCH of a given time, deliver on an overdue row without a message id) are structural validation of a write, each with a plain error naming the operation to use instead, and apply only where the gate is live.

## Decision points touched

| Decision point | Classification | Floor / arbiter or justification |
|---|---|---|
| Which stage a promise is in (time arithmetic over `softDeadlineAt`, `createdAt`, status, owner, machine, stamps) | invariant; basis: enumerable-domain; evidence: the inputs are durable record fields and the output is the closed stage set (none / midpoint / due-soon / overdue / recheck / last-resort) | Deterministic predicate in lateNoticeCore, tested on both sides of every clause. |
| What to do with a picked-up promise | judgment-candidate | Arbiter: the topic session reading the real record. Floor: bounded actions (deliver; keep working; one message with a new time, counted per §3.4); default is doing the work; the ladder ends at the deterministic last-resort template. |
| Whether a pickup took (`notified` / `started` / `held` / `failed`) | invariant; basis: external-constraint; evidence: the inject result and the awaited spawn's returned session name are the transport's own answers; nothing else reports a start | `held` and `failed` are retried; neither counts as taken. |
| Whether the record moved (delivered with a verified `deliveryMessageId`, or a reschedule bound to its delivery receipt) | invariant; basis: enumerable-domain; evidence: both are server-recorded receipts of a delivered message in the topic; a silent PATCH is refused by rule | Unmeasurable (history read fails) counts as not moved, which leads to one more pickup; if it stays unmeasurable through the second re-check, the `not-moving` last resort can follow. That is the accepted cost of failing toward doing the work again rather than assuming it was done. |
| Last-resort message | invariant; basis: irreversible-consequence; evidence: a message to the person cannot be recalled, so it is a fixed template behind a ladder that ends at a fixed point | One per promised time; Bounded Notification Surface caps (1 per conversation per hour) still apply. |
| Ladder counts (the `not-moving` trigger fires only when the session neither delivered nor rescheduled with a told time, so long work that is progressing is expected to reschedule, which the person is told once; told moves are never capped): 2 pickups, 3 failed starts, not taken by `T` + one re-check interval, 3 backoff attempts then one a day; short slip once ≤ 15 min; pending attempt timeout 5 min; 5 `pick-up` per review run | judgment-candidate | Floor: every count only delays the one irreversible step; arbiter: the pass report (`pickedUp`, `started`, `held`, `failed`, `lastResort` by variant) read during the 7-day dev soak; each is a named constant. |
| Timing: midpoint, due-soon 30 min, re-check interval `T − C` clamped 30 min–4 h | judgment-candidate | Derived from the promise's own length. Floor: timing only changes when a session is woken, never whether the person is messaged earlier. Arbiter: the session, which can move the time (counted, §3.4). |
| Start limits: lease holder only; `interactiveSpawnCapacity`; running sessions below `maxSessions`; working promise-work sessions plus pending ≤ a third of `maxSessions`; ≤ 3 starts per pass; parked starts ≤ 3 per day, parked 7 days then handed to the review | judgment-candidate | Floor: starts only below `maxSessions`, so the headroom up to the absolute cap stays the person's; the shared automatic-start gate still applies. The 3/3 values only spread a backlog; arbiter: the `held` counts by reason in the pass report. |
| Ending a finished promise-work session (promise delivered/rescheduled/parked; idle at prompt with no child process 30 min; `protectedSessions` passes; no message from the person since its start, in a history that reaches back that far) | invariant; basis: enumerable-domain; evidence: every clause is a recorded fact (row status, pane and process state, the protected list, the conversation log), and the action applies only to sessions this feature itself started | Any unknown clause means not ended. `killSession` itself has no guards, so all of them live in the release step. |
| No-time lane: running sessions only, 5 promises per notice, twice per promise, 3 conversations per pass | judgment-candidate | Floor: never starts a session, never messages the person. The values bound one pass's injects; the drain of the backlog is the promise review's job (30 rows per 6 hours, its own caps), so the lane's values only set how fast a running conversation is reminded. Arbiter: the session, which sets a time or delivers; the review covers what the lane misses. |
| Promise-review `set-time` / `pick-up` actions | invariant; basis: enumerable-domain; evidence: the apply route's existing action set is closed and server-validated; the two new actions are non-closing and carry the same evidence floor (quoted time, or a reason) | Refused without evidence, recorded per decision. |

## Multi-machine posture

- Promise records and all new stamps live on the commitment row in the creator's store. A row is mutated only by its creator (ids are per-machine counters), and peers see it through `CommitmentsSync`'s read-only replication: unified for reading, single-writer by design (the existing CommitmentTracker model, unchanged here).
- One voice: only the speaking machine acts on a row, and only the lease holder starts sessions. **Promises created on a standby are only partly covered by this spec:** they get notices into the standby's own running sessions, and when no session runs there the start is `held: not-holder` and, after one re-check interval, the honest `not-here` last resort (never `busy`), then backoff and parking. Starting a session on the holder for a standby's promise, and acting when the owner machine is down, are one gap tracked as fb-e2a65da1-b42. On Echo today the holder owns 502 of 503 open promises, so the gap covers about one row.
- The start limits read the lease holder's own session pool, which is where the start happens (machine-local-justification: physical-credential-locality; a session runs on one machine's Claude login and tmux, so its slots are that machine's).
- New stamps advance the replication counter. They are bounded by the start limits and the batched no-time save, so the extra replication is a few rows per pass.

## Frontloaded Decisions

1. A missed promise goes to a session first; the person hears on delivery, from the session when it moves the time, or from the last resort (Justin, 2026-11-18 12:11 PT).
2. Prevention is the main mechanism; the late path is the last resort (Justin, 12:14 PT).
3. Midpoint and 30-minute checks, both able to start a session.
4. Starts use the direct spawn path on the lease holder, never the inbound message pipeline.
5. The last resort never asks the person to act; the agent keeps retrying after it.
6. Urgency: every promise that could not be restarted gets the last resort, because silence would let it die unseen; everything short of that is the session's judgment, and moving a given time is always told.
7. No-time promises: running-session asks plus two new actions in the existing promise review; notices never prompt withdrawal.

## Open questions

*(none)*

## 6. Tests

- Unit, stage logic (`late-notice-core`, `late-notice-reconciler`): stage predicate on both sides of every clause; midpoint alone for promises under an hour, collapse only when due-soon also runs; checks stamped only on `notified`/confirmed `started`, retried on `held`/`failed`, confirmed checks never re-verified; pickup sends nothing; re-check at the proportional interval; every last-resort trigger and variant, including the reason-agnostic "not taken in time" deadline and the `pick-up` row's 4-hour interval without that trigger; last resorts combined per conversation and capped agent-wide (burst of 50 conversations); backoff, then daily, parked ordering, the 3-per-day parked cap, and the 7-day hand-off to the review; old `lateNoticeFor` rows still picked up; `held` never counted as failed.
- Unit, pickup (`promise-pickup`): typed outcomes; pending attempt reserves a slot, resolves from its own result, and reconciles against exited sessions; no start while a live session is bound; working-session limit at a third of `maxSessions`; start only below `maxSessions`; generic continuation skipped and bootstrap free of "The user's latest message" and `[telegram:`; no `sendToTopic` during a start; `admissionKind: 'automatic'`; release only when every clause holds and never on an unknown, with `protectedSessions` and `personMessagesSinceStart` checked.
- Unit, record rules (`commitment-reschedule`): reschedule intent recorded before the send; credential refusal 422; a quiet receipt is not delivered and leaves the time; crash recovery by operation outcome for delivered / failed / pending; second intent refused; grace once, at most 15 minutes, `softDeadlineAt` unchanged; PATCH of a given time refused (set and clear-then-set), allowed for a first time; deliver on an overdue row refused without `deliveryMessageId`, accepted with one sent since `C`; both rules lifted when the gate is dark; `set-time` quote checked against the topic window and refused for a time under 30 minutes away; `pick-up` capped at 5 per run; a pickup message alone forms no `CommitmentSentinel` pair.
- Integration (`overdue-promise-follow-through-routes`): running session gets the notice and the person gets nothing; no running session → the spawner is called with the bootstrap and the inbound pipeline is not; spawn throws three times → one last-resort message; capacity refusal → held, no message until the deadline; reschedule end to end through the route.
- E2E: the check-in reminder lifecycle test boots the pass with the real wiring and asserts the pickup dependency is wired to a real spawner, not a no-op.


## Maturation plan

- **test-agent-live:** the E2E boots the production path (real AgentServer, real CommitmentTracker, real TelegramAdapter with only Telegram's HTTP stubbed): a promise whose session is gone gets a session started through the real spawner with the system-notice bootstrap and no message to the person, and a promise past its time is picked up with no message to the person.
- **dev-agent-live:** live on Echo from the release that carries it (commitments.checkInReminder is enabled with dryRun false there). Live proof in topic 144400: a real promise whose session is stopped is restarted at its midpoint check, and a real promise whose time passes is picked up, with no system message to Justin in either case. For 7 days the pass report is read (pickedUp, started, held by reason, failed, lastResort by variant, parked) together with the reschedule route's counts.
- **fleet:** follows the check-in reminder's own graduation; its dryRun default flips fleet-wide in one place and this rides on it. Nothing separate is flipped.
- **graduation criterion:** on Echo over 7 days, at least one real promise restarted before its time and at least one picked up after it; zero person-facing system messages other than last resorts; every last resort explained by its variant; no session the person had written in ever ended by the release rule; and no reschedule intent left open past its end rule. A week with no pickups at all is not a pass.
- **dark-window:** at most 14 days from merge to the fleet decision; if the criterion is not met by then, the reason and a new date are recorded on the run's commitment.
- **ladder:** not applicable: no flag of its own, it rides the commitments.checkInReminder gate (test agent E2E, then Echo live, then fleet via that gate dryRun default)

## 7. Rollout and rollback

Ships inside the check-in reminder gate: live on development agents (Echo has `dryRun: false`), dark on the fleet. Live proof on Echo: a real promise whose session is stopped is restarted at its midpoint check with no message to the person; a promise whose time passes is picked up with no message to the person. The reschedule route exists everywhere, but the PATCH refusal for given times and the deliver-needs-message rule apply only where the check-in reminder gate is live (enabled and not dry-run), so dark fleet agents keep today's PATCH and deliver behavior. Rollback is `commitments.checkInReminder.dryRun: true`, read live, which also lifts those two rules; a revert restores the previous behavior, and old code ignores the new fields. No new config keys, so no config migration.

