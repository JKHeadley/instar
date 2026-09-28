# Side-Effects Review — a held Telegram reply no longer counts as "already delivered"

**Version / slug:** `dedup-held-not-delivered`
**Date:** `2026-09-27`
**Author:** `echo`
**Second-pass reviewer:** `required (outbound-messaging block/allow decision: content dedup)`

## Summary of the change

The origin send path (`TelegramOriginService.executePreparedBot`, and
`OriginBrowserExecutor.execute` for the browser transport) reserves a content
fingerprint in `outbound_origin_reservations` just before dispatch, so two
identical sends can't race. The reservation's life was `deadlineAt + 15 min`, and
only `completeOrigin` (a platform-accepted send) settled it. Every failure left it
live. So a send held with `destination-not-authorized`, a known-failed send
(`telegram-4xx`), and an outcome-unknown send (`transport-acceptance-unknown`,
`response-without-correlated-receipt`) all suppressed a fresh identical send.
That send came back `200 { suppressedDuplicate: true }`, and `telegram-reply.sh`
printed "NOT SENT — … an identical message was already delivered". Live on
2026-09-27 (Mac Studio, topic 102965), at least four times. Topic memory showed
none of those messages had been delivered.

Fix: when a reserved operation ends in an exception and no platform acceptance
was seen, the operation releases its own reservation. "No platform acceptance"
means no child already accepted in the store, and no `response.ok &&
body.ok === true` (bot) or `outcome.state === 'accepted'` (browser) in this run.
The release is an owner-fenced `UPDATE … SET expires_at = now`, matched on the
operation and on the outbox claim token that reserved it
(`SqliteOutboundDedupStore.releaseOrigin`; see §5). Accepted fingerprints in
`outbound_dedup` are never touched. When a released operation is retried, its
duplicate look-back reaches back to when it was prepared (`record.createdAt`).
So a fresh send delivered in the meantime always supersedes it, however late the
retry lands.

Files:
- `src/messaging/OutboundDedupStore.ts`: `releaseOrigin`
- `src/messaging/OutboundContentDedup.ts`: `releaseOrigin`, plus the
  `preparedAt` look-back in `reserveOrigin`
- `src/messaging/telegram-origin/OriginSendPolicy.ts`: optional `releaseContent`
- `src/messaging/telegram-origin/OriginContentDedup.ts`: implements it, passes
  `record.createdAt`, and extracts the shared destination key
- `src/messaging/telegram-origin/TelegramOriginService.ts`:
  `releasePreparedContent`, plus a try/catch around the dispatch loop
- `src/messaging/telegram-origin/OriginBrowserExecutor.ts`: the same try/catch

The legacy (non-origin) branch of `/telegram/reply` already recorded only after a
successful `sendToTopic` and released its in-memory reservation on a throw, so it
is unchanged.

## Decision-point inventory

- Origin content dedup (`reserveOrigin`). **Modify:** it now has two refusal
  answers. `duplicate` (a recorded platform acceptance in `outbound_dedup`)
  → HTTP 200 `suppressedDuplicate`, and the operation is terminally
  `suppressed`. `pending` (another operation's live reservation, i.e. in flight
  or partially accepted) → HTTP 409 `content-reservation-pending`, and the
  operation stays queued and recoverable. A reservation owned by an operation
  that ended with no platform acceptance is released, so it causes neither.
- Route content dedup (`/telegram/reply`, `isDuplicate`/`tryReserve`).
  **Pass-through:** already records only on success.

---

## 1. Over-block

This change removes over-blocking. Before, an identical send was wrongly
suppressed after every hold, refusal or unknown outcome. After, terminal
suppression needs a recorded acceptance (`outbound_dedup`) and nothing else. Two
other states hold an identical send without suppressing it (409
`content-reservation-pending`, still queued): an operation still in flight, and
an operation that got partial platform acceptance and so keeps its reservation.

One remaining over-block, kept on purpose: if the process crashes mid-dispatch,
no catch runs, so the reservation survives until `deadlineAt + window`. The send
really may be in flight, so keeping the reservation is correct there.

---

## 2. Under-block

- **Outcome-unknown then an agent resend.** If Telegram actually accepted the
  first send (the connection broke after acceptance), the agent's identical
  resend now goes out, and the operator sees it twice. This is the one deliberate
  trade. The old suppression claimed a delivery it had no evidence for, and in all
  the live cases the message had NOT arrived. The platform still never replays an
  unknown-outcome send itself (the outbox never retries outcome-unknown children),
  so the only possible duplicate is one the agent chose to make.
- **Held send retried by the outbox after a fresh send.** Not a duplicate. The
  retry goes back through `reservePreparedContent`. If the fresh send is still
  in flight, the retry finds its live reservation, answers `pending`, returns
  its undispatched claim and stays queued (not suppressed: in flight is not
  delivered, and the fresh send may still fail). If the fresh send was accepted,
  `reserveOrigin` finds it in `outbound_dedup` and answers `duplicate`. For this check the look-back is
  `min(now - window, record.createdAt)`, meaning any acceptance of this text since
  the operation was prepared. That covers retries that land more than 15 minutes
  later, which is normal on the browser path (its retry floor is 15 minutes). A
  429 backoff or a held-list retry can do it too. `outbound_dedup` keeps 24h of
  rows, which is longer than the 6h deadline. Only in that recorded-acceptance
  case is the retry marked `suppressed` (terminal) with nothing sent. Proven in
  `origin-service.test.ts` ("the held send cannot later duplicate it", an
  immediate retry after the fresh send was accepted; and the in-flight
  interleaving, where the retry is held, stays recoverable and later delivers
  once the fresh send is refused) and in `content-dedup.test.ts` (a retry 20
  minutes after the fresh delivery). A new operation prepared after the window is
  still an ordinary repeat.
  *(Added after second-pass round 1, which found that the plain 15-minute
  look-back let a late retry double-send.)*
- **Partial multi-child delivery.** Any accepted child keeps the operation's
  reservation (it is neither released nor completed). An identical fresh send is
  then held as `pending` (409, still queued), not suppressed, until that
  reservation expires at the original `deadlineAt + window`; after that an
  identical send can go out and repeat the accepted chunk. Dedup is exact-content
  only: a reworded resend has a different fingerprint and is not held or
  suppressed at all.

---

## 3. Level-of-abstraction fit

This is the right layer. The reservation lives in the dedup store, and the only
code that knows whether the platform accepted is the dispatch loop that owns the
reservation. The release is the mirror of the existing `completePreparedContent`
at the same seam. There's no new subsystem, and no change to the reply route or
the relay script.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no new block/allow surface.

The dedup is an existing deterministic invariant guard: exact fingerprint within
a window. This change narrows when it holds authority: it suppresses only on
recorded acceptance, and a live reservation (in flight or partially accepted)
only holds a send, leaving it queued. It adds no brittle judgment.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. "Did the platform
accept this send?" is an enumerable fact from the transport response, not a
judgment.

---

## 5. Interactions

- **Shadowing (round 2):** `reservePreparedContent` now runs inside the dispatch
  loop, right after the child's exclusive outbox claim is won, with that claim
  token as the reservation's owner. A refusal (`duplicate-content` or
  `content-reservation-pending`) first returns the undispatched claim
  (`releaseUndispatchedClaim`, audit detail `content-reservation-held`) so the
  child stays queued. The release runs only for the claim token this execution
  reserved under, so neither a refused operation nor a claim loser releases
  anything.
- **Double-fire:** `completePreparedContent` runs only on the success path,
  outside the try. The release runs only in the catch. The two never both run for
  one execution.
- **Races (round 2, from the Astra review):** a fresh identical send that
  arrives while the first is in flight is held (`409 content-reservation-pending`)
  and stays queued, never marked suppressed: in flight is not delivered. If the
  first then fails, the held one still delivers on its own retry. Two executions
  of one operation (initial send and recovery, or main and lifeline) contend for
  the outbox claim; the loser holds before reserving and cannot release the
  winner's reservation. A later claim of the same operation adopts ownership, so
  an earlier execution's late release is fenced out. The release `UPDATE` is
  fenced by `operation_id`, the owning claim token and `expires_at > now`.
- **Observed acceptance with an unsaved receipt:** when every child was accepted
  by the platform but the local receipt write failed, the execution now records
  the acceptance in the dedup store (`completePreparedContent`), so repeats are
  suppressed as confirmed deliveries rather than by a lingering reservation.
  Partial acceptance still keeps the reservation (conservative).
- **Feedback loops:** none. Nothing re-drives because of a release.
- **In-memory held list / outbox recovery:** both unchanged. They still own
  retries, and their retry re-reserves.
- **Tests that pinned the old contract** (`tests/integration/telegram-origin-routes.test.ts`,
  added with #2010). Two browser cases asserted the retention on purpose, and
  both are updated to the new contract. Their safety assertions are kept and
  strengthened:
  - (a) While a browser send is in flight, identical sends are held (409
    `content-reservation-pending`), not suppressed and not sent, and they do
    not release the in-flight owner's reservation. After an unaccepted
    ambiguous failure, the agent's fresh send goes out once. A genuine repeat
    after that is suppressed, and the two held contenders' own recovery then
    finds the confirmed delivery and stands down with no further send.
  - (b) Held, then the agent's resend is held too (409, not "already
    delivered"). When authority returns, `recoverHeld()` delivers exactly once:
    one operation is `accepted`, the other is `suppressed`, and there is one
    wire call.

---

## 6. External surfaces

- **Telegram:** a resend after a hold now reaches the user instead of being
  dropped.
- **Relay script output:** "NOT SENT — suppressed duplicate" now appears only
  when the text was really accepted. An identical send that meets one still in
  flight gets the ordinary held 409 (`content-reservation-pending`).
- **Persistent state:** `outbound_origin_reservations` rows get an earlier
  `expires_at` on release. One additive table, `outbound_origin_reservation_owners`
  (slot, operation, claim token), bounded by the 4096 slots. It is a side table
  rather than a new column, so an older build's positional insert keeps working
  after a rollback. The origin outbox gains one audit-detail value,
  `content-reservation-held`.
- **Operator surface:** no operator-facing actions.

## 6b. Operator-surface quality

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local by design.** The content reservation is owned by the machine
executing the origin operation (`executionOwnerMachineId`), in that machine's
`outbound-dedup.db`, exactly as before. A relayed send is executed and reserved
on the holder, and the holder is where the release now happens. The change emits
no user-facing notices and generates no URLs. It holds no new durable state that
could strand on a topic transfer.

---

## 8. Rollback cost

Revert and ship a patch. There is no data migration. Released rows simply have
an earlier `expires_at`, which the old code treats as expired slots. The added
owners table is ignored by the old code (tested: the old positional insert still
succeeds).

---

## Conclusion

The dedup now counts only platform-accepted sends as delivered. Held,
known-failed and outcome-unknown sends release their own reservation, so an
agent's fresh identical send goes out. Recorded deliveries still suppress. An
in-flight or partially accepted send holds identical sends (queued, 409) without
suppressing them. The
outbox's own retry of a held send stands down only after the fresh send is
confirmed delivered, and reservation release is fenced to the execution that
owns the outbox claim. So for ordinary sends and outbox retries, the platform
does not produce two confirmed deliveries of the same text. The one accepted trade is an agent-chosen resend after an unknown
outcome that had in fact landed. The second pass concurred after one round of changes.

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent (two rounds)
**Independent read of the artifact: concur (round 2)**

- Round 1, concern raised: a released held operation could be retried by the
  outbox more than 15 minutes after the agent's fresh send was accepted. On the
  browser path that is the normal case, because its retry floor is 15 minutes.
  At that point `reserveOrigin`'s 15-minute `sentSince` misses the delivery, and
  the retry double-sends. Resolved by looking back to `record.createdAt` (see §2),
  with a test that advances the clock 20 minutes.
- Round 2: "Concur with the review." `record.createdAt` is the preparation time
  on the bot, legacy-import and browser paths. The 24h `outbound_dedup` retention
  outlasts the 6h deadline. Fresh operations keep the ordinary window. One noted,
  judged harmless: a relayed operation's `createdAt` comes from the originating
  machine's clock, so clock skew shifts the look-back by the same amount.

---

## Round 3 — Astra review of PR #2087 (CHANGES REQUIRED → addressed)

1. *In-flight fresh send suppressed a held reply terminally.* The dedup result now
   distinguishes `pending` (another operation's live reservation) from
   `duplicate` (platform acceptance recorded). `pending` is a temporary hold that
   leaves the operation queued; only `duplicate` marks it suppressed. Regression:
   Astra's interleaving (held A, fresh B paused, A retried, B refused 400) — A is
   held, stays recoverable, then delivers.
2. *A claim loser released the winner's reservation (double send).* Reservation
   moved behind the exclusive outbox claim; the claim token owns release. Both bot
   and browser paths. Regression: Astra's concurrent-execution probe — one network
   call, fresh B held, later a confirmed duplicate.
3. *Worker timing flake (on unchanged main code).* Repaired under Rule 37, not
   quarantined: `store-worker-recovery.test.ts` used a 100 ms caller deadline
   around real SQLite work, and `healthyWindowMs: 1` raced a same-millisecond
   response. Deadlines are now 1 s with stalls scaled past them, and the checks
   that assert episode closure wait out the healthy window. No production timeout
   changed. Verified 8 concurrent copies of the file green.

## Round 4: Rule 37 disposition of the other observed test failures

Astra's round-2 review (VERDICT NO) required a disposition for every failure
seen during review. None of the test files involved is in the PR's changed code,
and a passing rerun is not treated as exoneration.

- `source-poller.test.ts` (both cases), **repaired (test-only)**. The test asserted
  exactly one callback per source write. One write can show the poller two
  metadata states. `writeFile` truncates before it writes: with a 1 ms poll, 60
  of 60 plain writes fired twice. On APFS, `rename` updates ctime a moment after
  the new file appears, and the fingerprint includes ctime: atomic writes still
  fired twice in the real test. The consumer's invalidation is an idempotent
  refresh. So the test now asserts at least one callback per change, waits for
  the callback count to settle before the delete step, and asserts no callback
  after close. Both sides were checked by mutation: a poller that never fires
  fails both cases, and a poller that keeps firing after close fails the close
  assertion. `OriginSourcePoller.ts` is unchanged.
- `worker-bounds.test.ts` ("verifies a shared archive once per page…"),
  **repaired (test-only)**. Each page hashes a ~2.6 MB archive, and under suite
  load that went past the 2 s default caller deadline. The case tests paging
  and verification counts, not deadlines, so its store gets
  `requestTimeoutMs: 20_000`. No production timeout changed.
- `telegram-origin-routes.test.ts`, 5 cases, **quarantined with a filed
  defect**: [#2088](https://github.com/JKHeadley/instar/issues/2088). Two copies
  of the file ran at the same time on unchanged `origin/main` (load ~16). They
  failed 1 and 2 cases (policy-absent, AutoUpdater notice, cross-topic session
  binding), while the PR head passed 26/26 twice in the same run. Astra's run and
  a builder run also saw the stand-down case and the changed-reminder case flip
  on the head. The likely cause is `#recordEvidence`'s fixed 250/500 ms sink
  deadlines: under disk load the service correctly holds (409
  `all-durable-recording-sinks-unavailable`). That cause is not proven. All five
  cases are `it.skip` with a comment linking #2088; the issue lists what re-arming
  them requires. None of these cases is in this PR's changed hunk. The PR's own
  browser regressions in that file still run.
- `origin-service.test.ts` ("retains the confirmed subset of skipped forwards…"),
  **quarantined under the same defect #2088**. In the round-3 targeted run it
  failed with the same hold (`all-durable-recording-sinks-unavailable`, thrown
  from `recordIntent` → `#recordEvidence`), and that path is byte-identical to
  main. The case is outside the PR's changed hunk. The PR's own regressions in
  that file still run.

## Evidence pointers

- `tests/unit/telegram-origin/origin-service.test.ts` → "content dedup counts
  only platform-accepted sends as delivered" (4 cases). Both sides: a confirmed
  send suppresses; platform-accepted with an unsaved receipt suppresses; held →
  the fresh send goes out, and the held retry is then suppressed with no second
  wire call; outcome-unknown and 429 → the fresh send goes out. The two "not
  suppressed" cases fail on origin/main.
- `tests/unit/telegram-origin/content-dedup.test.ts` → owner-fenced release; an
  accepted fingerprint is never un-suppressed; a released held operation retried
  20 minutes after a fresh delivery is suppressed (this fails without the
  `record.createdAt` look-back).
- `tests/integration/dedup-held-not-delivered.test.ts` → the full
  `/telegram/reply` route through the real origin boot: 409
  `destination-not-authorized`, then the identical resend gets 200 and is sent,
  then a genuine repeat is suppressed; 409 `transport-acceptance-unknown`, then
  the resend is sent.

---

## Class-Closure Declaration (display-only mirror)

Not applicable. This fixes runtime code, not an agent-authored artifact (prompt,
hook, config, skill or standards text), and adds no self-triggered controller.
