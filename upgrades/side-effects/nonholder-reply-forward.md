# Side-Effects Review — a non-lease-holder's replies are forwarded even while the session pool is dark

**Version / slug:** `nonholder-reply-forward`
**Date:** `2026-10-22`
**Author:** Echo (autonomous, topic 127831)
**Second-pass reviewer:** not-required (Tier 1; a three-line routing decision, a guard on a probe, and a notice-error catch — all on paths the existing forward-on-standby tests already cover)

## Summary of the change

Found by the 24h run on the Mama PC (2026-10-21/22): a machine that owns a
Telegram conversation but does NOT hold the serving lease could not answer the
operator at all for ~12 hours. Its sends were held with `lease-not-held` and
the forward-to-holder path that CLAUDE.md describes never fired.

Root cause: `telegram.holderForwardPolicy.decide()` answered `local` whenever
`multiMachine.sessionPool.stage` resolved to `dark` — the default on every
agent that has not rolled the pool out. `local` means "send direct", but a
direct send from a non-holder is ALWAYS held (`TelegramOriginBoot.authorize`
requires `holdsLease()`), so the dark-stage short-circuit made every
non-holder reply a durable hold. The forward never ran because the decision
that would have chosen it was never consulted.

Two related defects were fixed in the same change because they are each a
few lines on the same path:

1. `TelegramAdapter.resolveTopicName()` sends a real probe message (`"."`) to
   learn a topic's name. On a machine that forwards, that probe is a direct
   send: it is held, then replayed into the topic later as a stray `"."`. It is
   called from the respawn path, so a non-holder's respawn was both muted and
   mis-named.
2. `respawnSessionForTopic()` awaited the `Session respawned.` notice AFTER the
   respawn had succeeded; a held notice threw, and `POST /sessions/refresh`
   reported `respawn_failed` for a respawn that had worked, so the caller
   respawned again (the duplicate sessions the Studio observed).

Files modified:
- `src/messaging/telegram-origin/OriginForwardToHolder.ts` — new exported
  `decideHolderForward({ switchOn, poolStage, route })`: a confirmed healthy
  peer holder → `forward` at EVERY pool stage; self → `local`; an UNSETTLED
  lease keeps the old dark-stage answer (`local`, i.e. no 15 s settle wait on
  a pool that is not rolled out) and settles at a live stage.
- `src/commands/server.ts` — `holderForwardPolicy.decide` delegates to that
  function; the respawn notice is wrapped so a notice failure is logged, never
  thrown.
- `src/messaging/TelegramAdapter.ts` — `resolveTopicName()` returns `null`
  (stored/default name is used) when the machine would forward rather than
  send locally.
- `tests/unit/telegram-origin-forward-on-standby.test.ts` — the decision table
  (5 cases) and the probe guard (both sides).

## Decision-point inventory

- **Modified**: the adapter send route (`forward` / `local` / `settling`) for a
  token-holding machine. The route decides WHERE a reply goes, never WHETHER
  it goes: every branch still passes the holder's or the local tone gate and
  the credential wall. Loosened in one direction only — a confirmed peer
  holder is now forwarded to instead of held.
- **Modified**: `resolveTopicName()` now declines to probe on a forwarding
  machine. Fallback is the stored name or `topic-<id>` — the same fallback
  the callers already carry.
- **Modified**: the respawn notice is no longer load-bearing for the respawn
  result. Nothing else about the respawn changes.

## Roll-up across the review dimensions

1. **Over-block**: none. No path refuses something it previously allowed. A
   dark-stage machine with an unsettled lease still sends direct exactly as
   before.
2. **Under-block**: none. A forwarded reply is gated by the holder (the
   existing §4.1 contract: a tokenless/non-holder machine skips its local gate
   because the holder gates on receipt). The forward switch
   (`messageOrigin.forwardToHolder.enabled`) and `destination-not-authorized`
   (foreign chat, never forwarded) are untouched.
3. **Level-of-abstraction fit**: the fix lives where the defect was — the
   decision was correct in `classifyLeaseRoute` and wrong only in the server
   wrapper that pre-empted it. Extracting the wrapper into
   `decideHolderForward` makes the table testable instead of inline.
4. **Signal vs authority**: no new authority. The route is a deterministic
   structural fact (who holds the lease), not a content judgment.
5. **Interactions**: `willRelay()` (which decides whether the local tone gate
   is skipped) reads the same policy, so on a dark pool it now returns `true`
   for a peer holder — the reply route then skips the local gate and the
   holder gates it, exactly as on a live pool. The recovery tick's
   `forwardRecovery` for held rows is unchanged. The direct-path hold
   (`onLeaseHoldObserved`) still covers the race where the lease moves between
   the decision and `authorize`.
6. **External surfaces**: the operator now receives replies from a non-holder
   machine (through the holder's bot send) instead of silence; the stray `"."`
   probe replay stops; `POST /sessions/refresh` answers 200 for a respawn
   that succeeded. No new routes, config keys or messages.
7. **Multi-machine posture**: this IS the multi-machine path. Single-machine
   agents: `holderForwardPolicy` is only installed when `meshSelfId` is set and
   the machine holds its own lease, so `route.kind === 'self'` → `local`; a
   strict no-op. Machine-local by design (the decision is about THIS machine's
   lease view); the held row and its recovery were already replicated/handled
   by the existing forward machinery.
8. **Rollback cost**: a hot-fix release reverting the three hunks. No data
   migration; held rows written while the fix is live are ordinary
   `lease-not-held` rows the pre-fix recovery tick already understands. The
   per-agent switch `messageOrigin.forwardToHolder.enabled: false` returns a
   machine to the old `local` answer without a release.

## Tests

- `tests/unit/telegram-origin-forward-on-standby.test.ts`: 58 pass (5 new
  decision-table cases, 2 new probe cases; the 51 existing forward/hold/
  recovery cases unchanged).
- `tsc --noEmit`: clean.

## Class-Closure Declaration

- `unbounded-self-action` → closure: **n/a** — one-shot user-driven action, not a self-triggered loop: the change routes an existing reply to the lease holder, guards a name probe, and makes the post-respawn notice best-effort after an operator-requested respawn; no new self-triggered controller.
