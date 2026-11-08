# Side-effects review: Bring it back here and queued app messages (follow-up to #2905)

Tier 1. Two defects found by the first real two-machine move of an app conversation (throwaway agent `pool-proof-1107`, Mac M5 Pro and Mac Studio, 2026-11-08, step 7). Both sit behind `multiMachine.sessionPool.appConversations.enabled`, which is off for the fleet and on for development agents only. Spec: `docs/specs/app-conversations-in-the-pool.md`; ELI16: `docs/specs/app-pool-bringback-and-queue.eli16.md`.

## What changed

1. **Bring it back here appears once the owner stops answering, not 15 minutes later.** Placement and the bring-back guard both asked `ownerOnline`, which read the owner's `liveness.state === 'live'`. `deriveLiveness` keeps a peer `live` until its last direct success is older than `failoverTimeoutMinutes` (15 by default), so with the owner stopped for 6 minutes, placement still read `answering: true, bringBack.can: false`. The new `ownerAnswering` in `appConversationMove.ts` reads the owner as NOT answering only on this machine's own evidence: direct contact in this process that is older than `READINESS_CONTACT_MAX_AGE_MS` (2 minutes, the rule pool readiness already uses), or direct attempts in this process that are failing (`unreachable`). With only relayed or saved evidence, or no reading, it is unknown, and unknown never offers Bring it back here (independent review finding 1: right after the holder restarts, a healthy owner must not look stopped).
2. **A queued app message is delivered on an agent without Telegram.** The inbound queue handed every row to `_drainLocalDeliver`, which only `wireTelegramRouting` assigns, so on an app-only agent each attempt for an app row failed with `un-routable: local-tail-not-wired` until the row expired. The new `dispatchQueuedInbound` in `appConversationPool.ts` sends `app:` rows straight to the app tail and every other row to the local tail, as before.

## 1. Over-block

None. Neither change refuses anything new.

## 2. Under-block

A holder that just restarted, or a new lease holder, offers nothing until its own direct attempts say the owner is down; a dead owner is then offered after the first failed pulls. Bring it back here can now be offered while the owner is alive but has not been reached directly for over 2 minutes (for example, a network partition between the two machines). That is the case the feature is for: the operator confirms the warning ("its session will be stopped as soon as it reconnects"), and a returning owner is fenced by its lower epoch. A real flap still needs the operator's confirmed tap; nothing is taken over automatically.

Slack rows keep the old dependency on the Telegram-wired local tail. That is a separate defect, filed as fb-45347657-351, not widened into this change.

## 3. Level-of-abstraction fit

`ownerAnswering` sits next to the bring-back logic it serves and reuses readiness's constant, so "answering" means the same thing on both surfaces. `deriveLiveness` itself is unchanged: its 15-minute window belongs to failover, where a short window would cause needless takeovers. The queue fix sits in the one dispatch the queue calls, keyed on the row's kind.

## 4. Signal vs authority compliance

No new authority. `ownerAnswering` only decides whether an explicit, operator-confirmed action is offered. The queue change routes a row to the tail that already handles its kind. Per `docs/signal-vs-authority.md`, neither is a blocking judgement.

## 5. Interactions

- The router's forwarding of an app message does not read liveness: it attempts the delivery and queues on failure, so it agrees with the 2-minute offer (review finding 3 checked; the `ownerLiveness` read at the stale-owner engine is notice wording only). The pull cadence is about 30 s against the 2-minute bar, so a loaded holder could briefly flap the offer (review finding 2); cosmetic, since bringing back is a confirmed tap.

- The bring-back guard (`runBringBack`) uses the same `ownerOnline`, so the offer and the action agree.
- The move route's own target check (`target-offline`) is unchanged.
- Pool readiness is unchanged and shares the constant.
- On an agent with Telegram, app rows used to pass through `_drainLocalDeliver`'s own `app:` branch to the same `_appDrainDeliver`; they now reach it directly. Same function, same result. Telegram and Slack rows are untouched.

## 6. External surfaces

`GET /mobile/conversations/:key/placement` now answers `answering: false` and `bringBack.can: true` sooner when the owner stops answering. No new route or field.

## 7. Multi-machine posture

Both changes are the lease holder's view of a peer and the holder's own queue. Machine-local by design: each holder decides from its own direct contact.

## 8. Rollback cost

Revert. No data, migration or state to repair.

## Tests

`tests/unit/app-pool-bringback-queue.test.ts` (17 cases):
- The incident: a peer last reached 6 minutes ago still derives `live` but is not answering, and placement offers Bring it back here at 3 minutes.
- The 2-minute boundary, and that relayed or missing evidence never counts.
- App rows reach the app tail with no local tail wired, other rows keep the local tail, and the missing tail is named.
- A holder that just restarted: no offer for a healthy owner on saved evidence alone; an offer for a dead owner once its own direct attempts fail; withdrawn on the next direct success. Treating unknown or indirect evidence as stopped, or dropping the `unreachable` branch, fails these.
- An owner that returns inside the 2-minute window never flaps the offer: a 90-second gap with failed pulls still reads as answering, and a fresh contact after a 4-minute outage withdraws the offer on the next read.
- An agent without Telegram, end to end through the real `PendingInboundStore` and `QueueDrainLoop`: with no local tail wired, an app row queued while its owner is down stays queued, then is delivered once the owner answers. The old wiring, reproduced in the same rig, never reaches the app tail.
- The server wires both.

Each fix was undone in turn: restoring the old `ownerAnswering` fails 4 cases, sending app rows to the local tail fails 3 (including the end-to-end case), and the old server expression fails 1. Affected set: 292 unit tests (10 files), 56 integration (pool, team guards, inbound queue) and 10 e2e (two-node pool) pass.
