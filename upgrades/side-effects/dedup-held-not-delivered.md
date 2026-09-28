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
The release is an owner-fenced `UPDATE … SET expires_at = now WHERE operation_id
= ?` (`SqliteOutboundDedupStore.releaseOrigin`). Accepted fingerprints in
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

- Origin content dedup (`reserveOrigin`, which answers `duplicate` → HTTP 200
  `suppressedDuplicate`). **Modify:** a reservation owned by an operation that
  ended with no platform acceptance no longer suppresses.
- Route content dedup (`/telegram/reply`, `isDuplicate`/`tryReserve`).
  **Pass-through:** already records only on success.

---

## 1. Over-block

This change removes over-blocking. Before, an identical send was wrongly
suppressed after every hold, refusal or unknown outcome. After, suppression needs
one of three things: a recorded acceptance (`outbound_dedup`), an operation still
in flight, or an operation that got at least partial platform acceptance.

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
  retry goes back through `reservePreparedContent`. If the fresh send is in
  flight, it finds the live reservation. If the fresh send was accepted,
  `reserveOrigin` finds it in `outbound_dedup`. For this check the look-back is
  `min(now - window, record.createdAt)`, meaning any acceptance of this text since
  the operation was prepared. That covers retries that land more than 15 minutes
  later, which is normal on the browser path (its retry floor is 15 minutes). A
  429 backoff or a held-list retry can do it too. `outbound_dedup` keeps 24h of
  rows, which is longer than the 6h deadline. Either way, the retry is recorded
  `suppressed` (terminal) and nothing is sent. Proven in `origin-service.test.ts`
  ("the held send cannot later duplicate it", an immediate retry) and in
  `content-dedup.test.ts` (a retry 20 minutes after the fresh delivery). A new
  operation prepared after the window is still an ordinary repeat.
  *(Added after second-pass round 1, which found that the plain 15-minute
  look-back let a late retry double-send.)*
- **Partial multi-child delivery.** Kept suppressed: any accepted child keeps the
  reservation, so the user never gets chunk 1 twice from a reworded resend path.

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
a window. This change narrows when it holds authority, so that it only suppresses
on evidence of acceptance or live in-flight state. It adds no brittle judgment.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. "Did the platform
accept this send?" is an enumerable fact from the transport response, not a
judgment.

---

## 5. Interactions

- **Shadowing:** `reservePreparedContent` still runs before dispatch, and the
  release runs only after a thrown hold or failure from the dispatch loop. The
  duplicate refusal itself is thrown by `reservePreparedContent`, outside the new
  try, so a suppressed operation never releases another operation's reservation.
  The owner fence makes this doubly safe.
- **Double-fire:** `completePreparedContent` runs only on the success path,
  outside the try. The release runs only in the catch. The two never both run for
  one execution.
- **Races:** a fresh identical send that arrives while the first is still in
  flight still sees the live reservation and is suppressed, as before. The
  release happens only after the first has definitively failed. The release
  `UPDATE` is fenced by `operation_id` and `expires_at > now`, so it can't clear a
  reservation that a newer operation has since taken.
- **Feedback loops:** none. Nothing re-drives because of a release.
- **In-memory held list / outbox recovery:** both unchanged. They still own
  retries, and their retry re-reserves.
- **Tests that pinned the old contract** (`tests/integration/telegram-origin-routes.test.ts`,
  added with #2010). Two browser cases asserted the retention on purpose, and
  both are updated to the new contract. Their safety assertions are kept and
  strengthened:
  - (a) While a browser send is in flight, identical sends are still suppressed.
    Two suppressed operations do not release the in-flight owner's
    reservation. After an unaccepted ambiguous failure, the agent's fresh send
    goes out once. A genuine repeat after that is suppressed. Nothing is left
    for the outbox to recover.
  - (b) Held, then the agent's resend is held too (409, not "already
    delivered"). When authority returns, `recoverHeld()` delivers exactly once:
    one operation is `accepted`, the other is `suppressed`, and there is one
    wire call.

---

## 6. External surfaces

- **Telegram:** a resend after a hold now reaches the user instead of being
  dropped.
- **Relay script output:** unchanged. "NOT SENT — suppressed duplicate" now
  appears only when the text was really accepted (or is in flight).
- **Persistent state:** `outbound_origin_reservations` rows get an earlier
  `expires_at` on release. There is no schema change, and expired slots are
  already reused in place.
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

This is a pure code change: revert and ship a patch. There's no schema or data
migration. Released rows simply have an earlier `expires_at`, which the old code
treats as expired slots.

---

## Conclusion

The dedup now counts only platform-accepted sends as delivered. Held,
known-failed and outcome-unknown sends release their own reservation, so an
agent's fresh identical send goes out. Real deliveries, partial deliveries and
in-flight sends still suppress. The outbox's own retry of a held send is
suppressed if the fresh send took the content over, so the platform never
double-sends. The one accepted trade is an agent-chosen resend after an unknown
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
