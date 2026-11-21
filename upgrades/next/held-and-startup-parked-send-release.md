# Replies written during a restart are sent; long-held replies go back to their writer

<!-- bump: patch -->

## What Changed

Two silent-loss paths found in the 2026-11-20/21 Mac Studio outage review are closed.

**Replies parked while the server was starting.** When the reply script posts while the boot beacon answers ("the server is starting"), it queues the reply. Since the beacon's answer changed shape on 2026-11-16, the outbox no longer recognised that answer as proof the reply never left, labelled every such row "may have arrived" and never sent it. The proof now recognises the beacon's current body exactly (`OriginLegacy.isBootBeaconBody`), and the beacon exports its body builder (`bootBeaconResponseBody`) so a contract test pins the two together. A parked reply is now sent by the next recovery pass. An identical reply already resent by hand is suppressed by the existing content check. An unproved 503 row is counted (`legacy-503-unproved`), and an `outcome-unknown` imported row now reads `unknown` on the outcome route instead of falsely "pending, the server retries".

**Replies held because this machine did not hold the lease.** A held or parked reply is now checked against a 30-minute bound (from when it was first written) at every automatic release point: the startup-queue import, the direct send site in `recoverHeld`, and forwarded-hold recovery (`recoverForwardedHold`, shared by the quick ladder and the recovery pass). Past the bound it is never sent automatically: it is retired (`suppressed`, reason `stale-hold-handed-back`, text kept) and handed back to the session that wrote it as one line, or, when no session is running, raised as one plain hub attention item per conversation that ends "If it should still go out, tell me and I will send it." A forward whose last attempt may have reached Telegram is never retired; its receipt is still resolved first. A retired row can never be held again (no resurrection).

**Retire one held reply by id.** New `POST /telegram/origins/operations/:operationId/retire` (agent token; a phone token gets 403) stops one held or startup-parked reply on this machine with an optional note. It refuses a reply that is not held (409 `not-held`), may be mid-send (409 `in-flight`) or may already have arrived (409 `uncertain`). Every retirement, automatic or by request, writes a row to the new `telegram_origin_retirements` table (who, why, prior state, age), and the outcome route reports it. Per-operation routes now accept imported ids (`legacy:<delivery id>`).

## What to Tell Your User

- **Replies written while I restart now reach you**: "If I write to you while my server is restarting, that reply now arrives as soon as the server is ready. Before, some of those replies were silently lost."
- **Very old held replies come back to me instead of arriving out of the blue**: "If one of my replies gets stuck for more than half an hour, for example while another of your computers is the one sending messages, it no longer arrives late and out of context. The part of me that wrote it gets it back and decides whether it is still worth sending. If that part of me is no longer running, you'll see a short note in your attention list, and you can just tell me to send it."
- **I can cancel one stuck reply for you**: "If you tell me a reply that is waiting to go out should not be sent, I can now cancel just that one, and I keep a record of who cancelled it and why."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Retire one held reply by id | `POST /telegram/origins/operations/<id>/retire` with `{ "note": "..." }` |
| Read why a reply was not sent | `GET /telegram/origins/operations/<id>/outcome` (reason `stale-hold-handed-back` / `retired-by-operator`) |

## Evidence

- Unit: `tests/unit/telegram-origin/held-send-release.test.ts` (19 tests): the beacon proof against the real builder and the exact Studio body, lookalikes refused; the age rule ignores garbage/future values; import of fresh vs stale parked rows; every retirement refusal; no resurrection; marker kept through re-admission; holder retirement in one step; report backoff; the stale gate in forwarded recovery (retired, refusal never sends, Studio-shaped outcome-unknown rows untouched, older-owner branch settles without a replacement, `local-sent` untouched).
- Integration: `tests/integration/telegram-origin-held-send-release.test.ts` (8 tests): real runtime, worker and routes — fresh parked row sent once, identical hand resend suppresses the replay, stale parked row handed back with one hub item and a `not-delivered`/safe outcome for the `legacy:` id, direct lease holds fresh vs stale (one author line), re-admitted-then-aged row still retired, retire route 200/409/404/400/403 with audit row.
- E2E: `tests/e2e/held-send-release-lifecycle.test.ts`: production boot (`bootTelegramOrigin`) with the beacon's real body — fresh parked reply sent once, old one handed back to its live author, four Studio-shaped holds never sent, the retire route answers through the production route table (409 `uncertain`, never 503).
