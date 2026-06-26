<!-- bump: patch -->

## What Changed

Fixed the "session paused" lockout (topic 28130): `MessageSentinel` was consuming the operator's benign inbound messages whenever its LLM classifier returned — or capacity-shed to — `'pause'`, and the "send a message to resume" recovery routed back through the same failing gate, an inescapable loop. New constitutional standard **"The Operator Channel Is Sacred — Critical-Path Gates Fail Toward Delivery"** (in `STANDARDS-REGISTRY.md`) + its exemplar fix:

- `'pause'` now consumes a message ONLY on a DETERMINISTIC fast-path match; a bare-LLM or capacity-shed `'pause'` routes THROUGH (delivered to the agent), never consumed.
- Before routing a non-deterministic result through, a non-word-count-gated stop-token scan rescues a long-form genuine "stop" to a kill (so a real stop is never dropped).
- A per-topic circuit-breaker bounds blast radius (a misclassification stream can't permanently lock the operator out).
- Both inbound consume paths (`onSentinelIntercept` + `/internal/telegram-forward`) decide via one shared `MessageSentinel.decideInboundDisposition`, so policy can't diverge.
- `/sentinel/stats` now exposes disposition counters (consumed / routed-through / breaker-recovered).

## What to Tell Your User

If your agent ever appeared "paused" and ignored your messages — replying "Session paused. Send a message to resume." in a loop — that's fixed. A safety check could mislabel an ordinary message as a "pause" command and silently eat it (worse, under load it defaulted to pausing). Now your messages are delivered unless you *unambiguously* typed a pause/stop command, and a genuine "stop" is always honored. The channel to your agent can no longer be sealed by a wrong guess.

## Summary of New Capabilities

- Standard "The Operator Channel Is Sacred" — a gate on the operator's inbound channel must fail toward DELIVERY; a brittle signal may not consume/block a message; recovery must not route through the failing gate; decision-gates have bounded blast radius.
- `MessageSentinel.decideInboundDisposition` + `hasStopToken` + disposition observability counters.

## Evidence

- `tests/unit/MessageSentinel-operator-channel-sacred.test.ts` (13) — deterministic pause consumes; benign LLM-pause + capacity-shed route through; long-form stop rescued to kill; circuit-breaker auto-recovers; per-topic isolation; counters; hasStopToken both-sides.
- `tests/integration/operator-channel-sacred-wiring.test.ts` (3) — both consume sites use the shared disposition helper; old consume-on-any-pause gone.
- `tests/integration/telegram-forward-sentinel-intercept.test.ts` — updated to the disposition contract incl. a new route-through-delivers test.
- `tests/e2e/operator-channel-lockout-regression.test.ts` (4) — no benign stream (even with the LLM mislabeling every message, or sustained capacity-shed) can lock the channel; recovery is escapable; a genuine stop still honored.
- `npm run build` + `tsc --noEmit` clean; consume-path + MessageSentinel suites green.
- Converged + approved spec; convergence report at docs/specs/reports/operator-channel-sacred-convergence.md.
