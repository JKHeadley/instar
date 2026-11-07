# Side-Effects Review — App conversations move between machines (part 3b)

**Version / slug:** `app-conversations-in-the-pool`
**Date:** `2026-11-06`
**Author:** `echo (builder on the M5 Pro)`
**Second-pass reviewer:** `eight independent subagent rounds (see below)`

## Summary of the change

An app conversation, and its session, can now move between machines through a completed drain or the operator's "Bring it back here". Per-conversation fenced ownership (`app:<uuid>` records) replaces the all-or-nothing lease rule; a conversation that never moved has no record and behaves exactly as before. Adds `serves`/`mayReply`/`currentOwner`, a lease gate, close-on-loss, a capability flag enforced from the flagged side, router and receive-side app arms, key-typed journal rows, per-kind drain seams, the move and bring-back flows, and the phone's controls. Tier 2. Spec converged in 7 rounds; approved under the standing grant for Justin's 2026-11-06 14:11 message in topic 134088.

**Proportion:** Tier 2, about 55 files and 4,500 lines (roughly half tests), 7 spec rounds, 8 second-pass rounds. In line with the size: this is the pool's largest single arm.

## Decision-point inventory

- Who serves an app conversation (`AppConversationService.serves`) — add — fenced record, else lease holder with the gate open.
- Who may reply (`mayReply`, `ownsAlias`) — modify — adds the drain's last turn; no longer lease-only.
- May an app record be written (`runAppMove` gates, `AppFlagTracker`) — add — whole pool flagged, target flagged, owner can drain.
- Forward acknowledgement (`DeliverMessageHandler` app arm) — add — after verified durable ingest only; new `not-yet`.
- Sender check (`appForwardSenderValid`) — add — envelope must name the event and its paired device.
- Router dispatch (`SessionRouter.dispatchApp`) — add — never places.
- Consumers skipping `app:` keys (reconciler, stale-owner engine, duplicate reconciler, shed, pins) — modify — pass-through for every other key.

## 1. Over-block

- A move is refused while any online machine's flag reads unknown: until its first full heartbeat after it came online or the lease changed, or while it has only coarse beats. Deliberate, and said in words. Enforcement needs an unflagged reading held for two heartbeats, so a restart never reads as a downgrade.
- The lease gate holds no-record conversations for up to 30 s on a new holder. On a single machine it opens at once. A conversation created on the holder is exempt: nothing else can own it. An existing session's replies get 409 during that window on a multi-machine lease change.
- A message to a conversation whose owner is down waits up to the queue's limits (30 minutes or the attempt cap), then is refused in words. This is the spec's choice over automatic takeover.

## 2. Under-block

- The owner's alias is derived per machine and normally matches. The autonomous-run consent probe for a remote owner uses the holder's alias, so an alias collision could miss a run and skip the consent prompt. The drain still suspends the run honestly at the owner. Bounded and accepted.
- `open-commitment`, `active-subagent` and `recent-user-message` keeps can hold a stale, unbound copy alive (accepted in spec §2.1): it gets no messages and can't reply, but can finish tool work it had started.
- A reply on an unmoved conversation gets 409 for up to 30 s on a new multi-machine holder while the gate is closed. This matches spec §2.1 and §2.3 as written; the second-pass reviewer noted it sits uneasily with "unmoved means unchanged". Named here for the operator's judgment; not changed, since the spec converged on it.
- During the flag's unknown window after an older machine takes the lease, an in-flight reply can land from a moved conversation's owner (spec §2.6).

## 3. Level-of-abstraction fit

Decisions live with the owners of the state: serving in `AppConversationService`, routing in `SessionRouter`, acknowledgement in the shared handler factory, ownership transitions in the FSM and registry. Seams that need boot scope sit in `server.ts`; the logic is in two injected, unit-tested modules (`appConversationPool.ts`, `appConversationMove.ts`). It reuses the transfer route, drain runner, registry, router and part 1's ports rather than parallel machinery.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?** No. The blocks are structural invariants, not heuristics: a fenced epoch, an exact capability flag, an exact key grammar, a CAS. The stranded sentinel stays a pure signal with new words. Nothing takes an app conversation on a liveness guess: the only takeover is the operator's confirmed action.

## 4b. Judgment-point check (Judgment Within Floors standard)

**Does this change add a static heuristic at a competing-signals decision point?** No. The decisions are invariants classified in the spec's table. The owner's Sentinel call remains the existing judgment, unchanged, fail-open.

## 5. Interactions

- **Shadowing:** `dispatchOne` delegates `app:` keys to `dispatchApp` first, and `forceReplace`/`placeAndClaim` refuse them, so no Telegram path runs on one.
- **Double-fire:** a stop acts once by receipt. The holder's and owner's delivery events derive from one seed, so they merge.
- **Races:** the enforcer's release of the holder's own record skips a record with a move in flight or a drain running. The drain's epoch fence stays the backstop. A stop or pause bypasses the per-session chain and the stale fence only when this machine is the current owner at an epoch at least the forwarded one.
- **Journal receive validator:** `JournalSyncApplier` mirrors the emit-side schema and had to learn `sessionKey` and `takeover`; a rejection would halt the whole peer stream. The e2e runs the real signed hop and fails 6 of 9 tests with that reverted.
- **Inbound queue:** `_drainLocalDeliver` gains app and Slack arms; Telegram is unchanged. Slack previously failed there as a non-numeric key.
- **Delivery ledger (Stage B):** the target accepts custody only from the owner its own copy names, so with the hand-off active a move waits, bounded at 20 s with a nudge, for the target to hold the record. The e2e doesn't wire this step; a unit test covers the order and the bound. It needs the dev-agent-live proof.
- **Stop and the queue:** a stop settles this conversation's held rows on the holder, so messages sent before it don't run after it. Later messages are still taken, unlike a Telegram stop's sticky set.
- **Reply routes:** `ownsAlias` now resolves the key, so a moved conversation's owner replies off the lease.

## 6. External surfaces

- **Other machines:** new flag fields, `not-yet` ack (only sent to flagged machines), new journal rows (older readers skip them), `session-status` gains `appOwned` and `appRecent`.
- **The phone:** a send can answer 202 `waiting`; a stop can answer 503 `stop-not-confirmed`; new Move rows and `session-bring-back`. The app change is described separately and ships from the iOS repo.
- **Persistent state:** `app_<uuid>.json` ownership records, journal rows.
- **Timing:** forwards depend on journal replication (about 15 s, shortened by the ownership nudge).

## 6b. Operator-surface quality (Operator-Surface Quality standard)

The phone's menu and refusal words are plain sentences with no internals; a comment in `dashboard/console/sessions-model.js` changed, with no rendered change. Not a dashboard renderer change.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Replicated.** Ownership: the coherence journal's `topic-placement` kind (`emitAppPlacement`) materialized by `OwnershipApplier`. Conversation events: the existing `appConversations` store. Aliases are per-machine, derived from the key and minted on demand. Delivery custody moves by the existing ledger hand-off. Memory scope is machine-local BY DESIGN (spec decision 6), and the move says so. One-voice: the bring-home notice is raised by the lease holder only. Durable state doesn't strand on a move: a `transferring` record is resolved by its owner past the drain deadline.

## 7b. Rollout gate

Off for the fleet, on for development agents: `multiMachine.sessionPool.appConversations.enabled` through `resolveDevAgentGate`, registered in `DEV_GATED_FEATURES`, on top of the pool's stage. With it off, `active()` is false, so the flag isn't advertised and the service, router arms, moves and enforcer all keep today's lease-holder rule. The named duplicate limit below can't reach a user until this is turned on, which follows the first real two-machine move.

## 8. Rollback cost

Revert and release; no data migration. Older code serves every app conversation from the lease holder and ignores `app:` records for serving. Leftover records are inert for serving, though an older machine's shed, stranded notice, reconciler or stale-owner engine may read them (spec §8). Before a deliberate downgrade, move every app conversation back to the lease holder; the release note says so.

## Second-pass review

**Reviewer:** independent subagent, read-only, against the spec and code, no conclusions handed to it.

First pass raised concerns, all confirmed and fixed in this change except where noted:
1. A restart's boot-time or coarse-beat "unflagged" reading triggered force-claims and stand-downs. Fixed: a full report held for two heartbeats, coarse beats say nothing, the flag re-advertised the moment it turns on.
2. The holder appended `delivered` before the owner dispatched, hiding `unknown`. Fixed: the holder answers `forwarded`; only the owner appends the outcome.
3. With the Stage B ledger on, an unmoved conversation could never move: the target had no record. Fixed: `awaitTargetRecord`.
4. A stop didn't reach messages held in the queue. Fixed: `dropHeld`.
5. A lease hiccup closed unmoved sessions. Fixed: requires another machine named as holder.
6. A gate answer's flag overrode later heartbeats. Fixed: the newest report wins.
7. Bring-back trusted `online`, kept true by coarse beats for up to an hour. Fixed: direct-contact liveness.
8. False "stays" on a timed-out drain still moving. Fixed: "may still complete".
9. A stuck `placing` baseline. Fixed: the enforcer finishes it.
10. A retried held request replayed `waiting`. Fixed: it answers where the message ended up.
11. Replies refused during a closed gate. Not changed: as the spec is written; named under Under-block.
12. The gate could open with no peers at boot. Fixed: asks every registered machine.

The reviewer found no defects in placement paths, epoch rules, dark behaviour or security.

**Re-check of the fixes (a second independent subagent)** raised six more, all confirmed and fixed:
1. The boot sweep had no app arm, so a crashed forward stayed `pending` forever. Fixed: the sweep and the drain share `settleAppNotInjected` and `settleAppQueueLoss`.
2. The registry carries flags forward on coarse beats and stamps them fresh, so a machine that went quiet after one false report read as unflagged, risking an unconfirmed force-claim. Fixed: `seamlessnessFlagsReceivedAt`; unflagged needs a second full report two heartbeats after the first.
3. "Bring it back here" lived only in the session menu, which has no row for a dead machine. Fixed: `GET /mobile/conversations/<key>/placement`.
4. `awaitTargetRecord` refused moves of records older than the status row's cutoff. Fixed: `appRecent` lists newest first with no age cutoff.
5. A held stop could fire late, and new messages could overtake held ones. Fixed: a stop is never queued; a new message goes behind held ones.
6. A stop didn't fence a forward between retries. Fixed: a per-conversation stop generation in the router.
Minor: a retried request now reports `unknown`, and a queue loss's words follow its reason.

**A narrow third check of those fixes** raised two more, both fixed: a send on its last attempt when a stop landed could queue and run after the stop (the router's queue step now checks the stop generation), and the orphan-store backstop skipped the app settlement (it now settles too). Everything else in that check held: flag reports on real beats, the placement route, `appRecent`, urgent outcomes, drained rows never looping, and `appBehindHeld` not deadlocking.

**A fourth check of those two fixes** confirmed both close their failures and raised two low-severity defects, both fixed: a stop after a failed attempt told the phone "not delivered" though the owner may have taken it with only the answer lost (it now reads `unknown`, which yields to the owner's own outcome), and the settle helpers dropped `app:` rows silently when the app service wasn't running (those rows now keep today's notice).

**A narrow fifth check** confirmed those fixes and raised two low-severity defects, both fixed: a retried send kept the old `unknown` words after the state settled, and a stop dropping a held message recorded a definite `refused`, though an earlier attempt may have reached the owner (it now reads `unknown`). Named limit: a held message that runs out at the queue's limits is still `refused`, as the spec says, even if an unanswered attempt did reach the owner; that takes 30 minutes of no answer.

**A sixth check of those two changes** raised three low-severity defects in the retry answer, fixed in one place: a retry now replays its record, words and status intact, while the state is unchanged, and drops the old words once the state moves on. A stop-dropped message records `outcome-unknown`, not `not-delivered`, which the spec treats as safe to resend.

**A closing check of the retry answer** confirmed it and raised one blocking defect, fixed: a queue loss from a restart or a nap (`stale-custody`, `nap-stale` and others) told the phone flatly to send again, for a message the owner may have taken. Now only `sender-deauthorized` and the queue's own limits record `refused`; every other loss reads `unknown`. It also raised a smaller gap, not fixed: a routed 503 `owner-unavailable` record can't be told apart from a plain send's, so if the owner's outcome arrives later, a retry answers with that state plus the old words. This needs a refused enqueue on top of lost answers, and the state itself is right.

**An eighth round, on the classification** (at Echo's request, since round 7's finding was blocking) confirmed it: every reason the queue reports lands in the right state, and `sender-deauthorized` is truly known at each caller. It raised gaps around it, all fixed:
- A quarantined queue store, or a config that closes the engine, left a send `waiting` for good, since no row remained to report. Fixed once for any such cause: a send still `waiting` 45 minutes on (past the queue's limit) reads `unknown`.
- The queue's local retry after a bring-back could dispatch a message a machine had already taken, or one still dispatching past the deadline. It now checks the delivery state and an in-flight set first, and a local refusal reads `unknown`, since it says nothing about an earlier attempt.
- A failed delivery write skipped finishing the request. They are separate steps now.
- Wording: the sender-refused text no longer mentions pairing, and stale comments are corrected.

**Remaining limit:** a duplicate is still possible if an attempt reached another machine and its delivery event hasn't replicated when the retry runs. The check reads this machine's copy of the state.

Reviewer outcome: eight independent rounds. Placement, epochs, dark behaviour and security had no findings in any round; every later finding was in how an uncertain send is recorded, or about messages lost around restarts. Round 8 raised concerns, so the trace records `reviewerConcurred: false`, and its fixes have had no further round.

Not closed: a forward attempt already on the wire when a stop arrives can still be accepted. The owner may then run that message before the stop reaches it, or just after. That is ordinary send-then-stop ordering; it is named, not fenced.

## Class-Closure Declaration

**`unbounded-self-action`: closure `guard`.** Citation: `tests/unit/self-action-convergence.test.ts`, enforcement `ratchet`. The `app-pool-enforcer` controller runs the real enforcer under an always-older machine and an always-refusing owner: one force-claim per record, one notice per episode, and each refused drain home waits five minutes. The close-on-loss retry is a local, refusable close that starts nothing.
