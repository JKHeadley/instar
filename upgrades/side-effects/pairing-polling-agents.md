# Side-Effects Review — Pairing on an agent with no lifeline (polling)

**Version / slug:** `pairing-polling-agents`
**Date:** `2026-10-21`
**Author:** `Dawn`
**Second-pass reviewer:** `Echo, on the Studio, 2026-10-21: approved e0b2cd93e (read the diff, did not run tests) with two fixes, applied in the follow-up commit; no further round needed`
**Spec:** `docs/specs/a2a-pairing-invite-link.md` §6.1 (r7, approved: false).

## Summary of the change

After 1.3.1383, Justin's PP test still got "use the dashboard". Luna read PP on its machine (read-only, 13:27 PDT): 1.3.1384, **no lifeline process**, `armedBy: no-lifeline-ingress`, mode enforce. PP's server polls Telegram itself. Pairing had three dead ends for that setup. `enforcing` was false whenever `isPolling`. A forwarded invite on the polling path answered "I can't take it from this chat". A `pi:` tap on the polling path answered "Approve this on the dashboard".

1. `src/messaging/TelegramAdapter.ts`: `PollingPairingHandler`, `setPairingHandler()`, `hasPairingHandler()`. With a handler, an invite from an **authorized** sender goes to `onForwardedInvite` and a `pi:` callback goes to `onCallback`, both `verified: true` (read from Telegram's own `getUpdates`). An unauthorized sender still gets nothing. Without a handler, behaviour is unchanged.
2. `src/server/routes.ts`: `ctx.telegram.setPairingHandler(pairingInviteTelegram)`. `enforcing` is `tapsProvable() && (!isPolling || hasPairingHandler())`, and `whyNoButtons` names polling only when no handler is wired.
3. `src/server/LifelineIngressGuard.ts`: `tapsProvable()` calls `armIfNoLifeline()` first, as `health()` and `guardStatus()` already do. A fresh polling agent's guard arms only when something reads it, and pairing may be the first thing that does.

## Decision-point inventory

- Polling path: whether an invite / pairing tap reaches the pairing handler — **add** — only with a handler wired; the invite only from an authorized sender.
- `enforcing` while polling — **modify** — true when the handler is wired and the guard can prove taps.

## 1. Over-block

Reduced: polling agents get buttons.

## 2. Under-block

The question is whether a polling tap is a weaker proof than a lifeline tap. An update read with `getUpdates` comes from Telegram over TLS, authenticated by the bot token, and its `from.id` is Telegram's own. The lifeline path proves the same thing, that Telegram delivered this update, with its secret over the local hop. Both are cooperative boundaries on one OS user: a process that can read the bot token in config could also read the lifeline secret file. The handler still requires the owner's id, the configured chat, and the one-time token bound to this invite and step, so another group member's tap is refused (tested). The internal routes are unaffected: on a polling agent the guard is armed `no-lifeline-ingress` and enforces, so a Bearer-token POST to `/internal/telegram-callback` without the secret is refused, and `operatorTap` refuses `verified: false`.

## 3. Level-of-abstraction fit

The adapter owns "where an update came from". Pairing keeps every authority check in one place, `PairingInviteTelegram`.

## 4. Signal vs authority compliance

The authority is still the owner's tap; the polling path only delivers it.

## 5. Interactions

Tunnel-consent and prompt-gate callbacks are unchanged; `pi:` is checked first, as before. The invite still never reaches a session, the inbound log or a classifier (test: routed stays empty).

## 6. External surfaces

Telegram on polling agents: Approve/Decline/Finish/Not them/"It's one of my agents" buttons instead of the dashboard lines.

## 7. Multi-machine posture

Machine-local: the adapter that polls is the machine's own.

## 8. Rollback cost

Remove the `setPairingHandler` call in routes; the adapter falls back to the old lines.

## Echo's review

Approved. It confirms §2, and that re-delivery is safe without the route's durable claim store, because tokens are one-time and their siblings are deleted on first use. Two fixes, both applied: (1) the adapter's comments described only the fallback, and now describe both paths; (2) if the invite handler throws, the owner now gets the dashboard line instead of silence (tested, mutation-checked). Echo's notes: with the guard bypassed, a polling agent loses its buttons (matches "bypass = old behaviour"), and tokens are machine-local in memory, as on the lifeline path.

## Evidence pointers

- Unit: `tests/unit/pairing-invite-never-persisted.test.ts` (polling adapter + handler, 4 cases); `tests/unit/lifeline-ingress-guard.test.ts` › fresh polling agent (mutation-checked).
- Integration (real routes): `tests/integration/pairing-invite-telegram-routes.test.ts` › POLLING agent (mutation-checked: removing the wiring fails it).
- E2E: `tests/e2e/threadline/pairing-handshake-production-path.test.ts` › POLLING agent (real adapter `processUpdate`, real relay; mutation-checked: adapter ignoring the handler fails it).

## Class-Closure Declaration (display-only mirror)

Class `unbounded-self-action`, closure **n/a**: one-shot user-driven action, not a self-triggered loop. When the pairing handler throws on a forwarded invite, the adapter sends one dashboard-line reply to that topic. It runs once per owner forward, has no retry, and nothing it sends can trigger it again. No agent-authored-artifact defect is fixed.
