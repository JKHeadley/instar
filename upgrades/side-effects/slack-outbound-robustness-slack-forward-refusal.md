# Side-Effects Review — /internal/slack-forward typed refusal (§2.7)

**Version / slug:** `slack-outbound-robustness-slack-forward-refusal`
**Date:** `2026-07-03`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Spec §2.7 (round-1 M6). As deployed, `POST /internal/slack-forward` took `{channelId, text}` and called `ctx.slack.sendToChannel(channelId, text)` — but its only caller, `SlackLifeline.forwardToServer`, forwards INBOUND user messages, so the route's sole live semantic is an ECHO BUG (posting the user's own message back at them). `SlackLifeline` is written but never instantiated, so this echo path has never run live. Both round-2 externals rejected gate-only: gating an echo defect still ships an echo defect the day `SlackLifeline` is wired. The change makes the route a typed refusal: it returns `409 { error: 'misdirected-route', detail: '…re-point owned by Phase 2.2…' }` and raises ONE deduped attention breadcrumb per boot. Bearer auth is preserved (the route stays inside the authed router). The real inbound path (session injection, mirroring `/internal/telegram-forward`) is Phase 2.2.

Files touched: `src/server/routes.ts` (the route body + a boot-once breadcrumb latch), `tests/integration/slack-forward-refusal.test.ts` (new), `tests/integration/slack-mrkdwn-reply-route.test.ts` (updated the old echo-behavior assertion to the refusal contract).

## Decision-point inventory

- `/internal/slack-forward` body — replace — the `sendToChannel` echo with a `409 misdirected-route` typed refusal.
- `slackForwardBreadcrumbRaised` latch — add — a createRoutes-scoped boolean so the attention breadcrumb fires at most once per boot (a caller loop can't flood the attention queue).

## 1. Over-block

The route no longer "delivers" anything — but there was no legitimate delivery to block: its only traffic was an inbound message being echoed back out, which is a defect, not a feature. Fail-toward-delivery deliberately does NOT apply here (argued, not assumed): delivering this route's traffic means posting the user's own inbound text at them. The refusal is the loss-free direction.

## 2. Under-block

The route still accepts and 409s any payload (it doesn't validate `channelId`/`text` first) — intentional: the point is that NO shape is legitimate on this route until Phase 2.2 re-points it. An unauthed request is still rejected by the router's auth middleware before reaching the handler (unchanged). The full session-injection re-point (the inbound exactly-once ledger + sentinel intercept) stays Phase 2.2 by design — this increment only closes the echo hazard window.

## 3. Level-of-abstraction fit

Yes. The refusal lives at the route that owns the response; the one-time breadcrumb latch is route-scoped state alongside the other per-boot route state.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — a static typed refusal, no heuristic, no blocking authority over content. It removes an outbound send entirely (strictly less exposure).

## 5. Interactions

Composes with the rest of the Slack outbound hardening: the legitimate outbound path is `/slack/reply` (now idempotent + timeout-bounded); this route is fenced off until Phase 2.2 gives it a real inbound semantic. The attention breadcrumb rides the existing `ctx.telegram.createAttentionItem` best-effort surface.

## 6. External surfaces

`/internal/slack-forward` response changes from `200 { ok }` / `500` to a fixed `409 { error: 'misdirected-route', detail }`. One deduped attention item id `slack-forward-misdirected-route`. No new route/config/env/CLI.

## 6b. Operator-surface quality

The one attention breadcrumb is plain-English and names the owner (Phase 2.2) — an operator seeing it understands the route was hit and that a re-point is pending, not a live failure.

## 7. Multi-machine posture

The breadcrumb latch is per-process (per boot, per machine) — a benign duplicate across machines is bounded to one-per-boot-per-machine and deduped by stable attention id. No shared state.

## 8. Rollback cost

Trivial: restore the `sendToChannel` body + latch + tests. A rolled-back binary echoes again (the deployed defect) — which is exactly what this closes, so rollback is a conscious regression, not a silent one.

## Conclusion

Closes the `/internal/slack-forward` echo-bug hazard with a typed 409 refusal + a one-time breadcrumb, deferring the real inbound re-point to Phase 2.2, under the Testing Integrity Standard with route tests (refusal + no-post + once-per-boot breadcrumb).

## Second-pass review (if required)

Not required — a static route refusal removing an outbound send, reversible, tested both directions.

## Evidence pointers

- `src/server/routes.ts` — `/internal/slack-forward` 409 refusal + `slackForwardBreadcrumbRaised`.
- `tests/integration/slack-forward-refusal.test.ts` — 409 refusal + once-per-boot breadcrumb.
- `tests/integration/slack-mrkdwn-reply-route.test.ts` — updated to the refusal contract (was the echo assertion).
- `docs/specs/slack-outbound-robustness.md` §2.7.

## Class-Closure Declaration (display-only mirror)

Class: the ungated internal Slack outbound route (the audit's "one internal route bypasses even that"). This increment fences it off entirely (409 refusal) until Phase 2.2 gives it a real inbound semantic.
