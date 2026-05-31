# Side-Effects Review — Tokenless standby Telegram outbound relay (bug #7)

**Version / slug:** `standby-telegram-outbound-relay`
**Date:** `2026-05-31`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

`TelegramAdapter` gains a settable `outboundRelay` callback. In `sendToTopic`, when
the adapter has NO bot token AND a relay is wired, the send routes through the relay
instead of the Telegram API (the relayed id feeds the same log/stall/promise
bookkeeping); a relay returning null throws. `server.ts` wires the relay to POST the
lease holder's `/telegram/reply/:topicId` (Bearer authToken + the holder's peer URL),
refusing to relay to self/unknown. Closes bug #7 (a session moved to a tokenless
standby was mute).

## Decision-point inventory

- **sendToTopic branch** — `!this.config.token && this.outboundRelay` → relay; else →
  the unchanged API path. Both covered by tests.
- **relay closure** — `holder` is self or unknown, or no URL → return null (no
  relay); else POST and return the id (or null on non-ok / throw). Self-relay guard
  + null-on-failure tested via the adapter-level null case.

## 1. Over-block

**What legitimate inputs does this reject?** Nothing for a token-holding machine — its
send path is byte-identical (the relay branch is skipped). For a tokenless standby, a
send that previously failed silently (no token) now either relays successfully or
throws a clear error (better than the silent mute). No legitimate send is dropped.

## 2. Under-block

**What does this still miss?** It does not sync conversation CONTEXT to the moved
session (audit #2 — the reply may lack prior history). It relays to the current lease
holder only (correct for the single-Telegram-owner model); if the holder is
unreachable it returns null → `sendToTopic` throws (surfaced, not silent). It does not
retry/queue a failed relay (the caller/​session sees the throw); a durable relay queue
is possible later but out of scope.

## 3. Level-of-abstraction fit

**Right layer?** Yes. The send decision lives in `TelegramAdapter.sendToTopic` (the
one outbound chokepoint), expressed as an injected callback (same pattern as the
adapter's other `on*` hooks). The cross-machine resolution (holder → URL → POST) lives
in `server.ts` where the mesh/coordinator/authToken are already in scope. The relay
reuses the existing `/telegram/reply` route rather than a new mesh command.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

No new blocking authority. It changes HOW a tokenless adapter sends (relay vs direct),
not WHETHER. It preserves the single-Telegram-owner safety invariant (the standby
never sends on the bot directly), which is the 409-conflict guard — strengthening, not
weakening, a safety property.

## 5. Interactions

The relay POSTs the holder's `/telegram/reply` — the same route used for normal
replies — so the message goes out the one bot the holder owns; no second poller/sender
(no 409). Pairs with the lease coordinator (`getSyncStatus().leaseHolder` picks the
target) and peer presence (`peerUrl`). On a token-holding router the callback is wired
but never invoked. Idempotent per call; a failed relay throws (the session's reply
attempt errors rather than silently vanishing).

## 6. External surfaces

One cross-machine HTTP POST from a tokenless standby to the holder's existing
`/telegram/reply` (Bearer-authed). No new route, config, or notification. The visible
effect: a moved session's replies reach the user (via the holder's bot).

## 7. Rollback cost

Low. Remove the `outboundRelay` callback + the `sendToTopic` branch + the wiring; a
tokenless standby's sends revert to silent failure (bug #7). No schema, no state, no
migration (the callback is in-memory, default null).

## Conclusion

Minimal, injected-callback change scoped to the tokenless-send path, reusing the
existing reply route, preserving the single-owner 409-guard, both branches + the
null-failure case unit-tested, no change for token-holding machines, cheap revert.
The completion gate for the live transfer — a moved session can now reply.

## Second-pass review (if required)

Not required — scoped to the no-token send path, reuses a battle-tested route,
strengthens (not weakens) the single-owner invariant, both branches + failure tested,
reversible. The live two-machine re-test (a reply landing) is the Tier-3 gate.

## Evidence pointers

- `tests/unit/TelegramAdapter.test.ts` — tokenless adapter relays (API not hit, relayed
  id returned); token-holding adapter sends directly (relay not consulted); relay→null
  throws (no silent mute).
- 19 TelegramAdapter tests green; `tsc --noEmit` clean.
- Found live: mini telegram adapter `botToken=MISSING` → a moved session's reply muted.
- Spec: `docs/specs/standby-telegram-outbound-relay.md` (+ `.eli16.md`).
