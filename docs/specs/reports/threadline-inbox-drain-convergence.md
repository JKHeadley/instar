# Convergence Report — Threadline Inbox/Deliberate-Drain (Phase 2b / CMT-493)

**Spec:** docs/specs/THREADLINE-INBOX-DRAIN-SPEC.md
**Date:** 2026-05-25 · **Mode:** two reviewers (completeness + adversarial),
grounded against live code at v1.2.75.

## Verdict: DEFER the full inbox-drain keystone. (Build the cheap global cap only if insurance is wanted now.)

The spec's own honest scoping question ("is this worth building now, given Phase 1
fixed loops and 2a unified the store?") answers itself against the live data.

### Scale evidence (the decisive finding)

Grounded in `~/.instar/agents/echo/.instar/threadline/`:
- **known-agents: 2** (codey + echo itself) → effective peer count **1**.
- **8 threads ever** (lifetime, not concurrent); **max turn-depth 1**.
- inbox 10 lines, outbox 23. No melting machine, no runaway-spawn incident, no
  concurrency contention.

The spec's stated driver — "many concurrent agent conversations + a first-contact
triage surface" — **does not exist in the data**. This is speculative
future-proofing for a network that is today two agents on the operator's machines.
The correctness driver (loops) is already solved by the Phase 1 `WarrantsReplyGate`
(novelty-gated turn budget + per-sender ack rate limit).

### Design findings (if it were built anyway)

| # | Severity | Finding |
|---|----------|---------|
| 1 | FATAL | The "warm listener already drains an inbox" seed is **dead code** — `readInboxEntries`/`getUnprocessedEntries`/`acknowledgeEntry`/`buildBootstrapPrompt` have ZERO production callers; no warm Claude session is ever launched to consume the queue. `shouldUseListener→writeToInbox→return` (server.ts:7165-7170) routes messages into a write-only black hole (a latent bug). So the drain loop is GREENFIELD, not "consolidation." |
| 2 | BLOCKING | `inbox.jsonl.active` is an **append-only, multi-writer audit log with no consume/ack** (written by both the server funnel and the listener daemon; read by observability/bridge). The at-least-once drain is net-new machinery, not a promotion. `OfflineQueue` cited as a seed is the relay-server's buffer, not an agent-side primitive. |
| 3 | BLOCKING | Adding `awaiting-drain` to `ConversationState` silently corrupts `ThreadResumeMap.toThreadState` (non-exhaustive `return s` fall-through → out-of-union value, no compile error); plus 5 other `'active'\|'idle'` switch sites would make such conversations invisible to resume/MCP. |
| 4 | RISK (→blocking for the cap) | `humanInLoop` is **hardcoded `false`** at both inbound gates (server.ts:7096, routes.ts:11882) with NO derivation anywhere. The "humans stay instant via live-inject" carve-out has no implementation hook — so under the cap, EVERY inbound (incl. a genuine fast-reply request) could queue behind `maxDrainWorkers`. |
| 5 | RISK | DrainCoordinator is a new **single-point-of-failure** scheduler (Phase 1's gate was stateless) with no watchdog/liveness/fallback — strictly worse availability than today's N independent spawn paths. Plus stuck-worker-holds-slot, queue starvation, priority inversion — under-specified. |
| 6 | RISK | It becomes a **4th overlapping concurrency governor** atop PipeSessionSpawner (maxConcurrent 5), SpawnRequestManager (maxSessions + cooldown), ComputeMeter, and would fight SessionWatchdog (which kills the very workers holding drain slots). |
| 7 | RISK | At-least-once "consume after send" + crash-before-mark = **double-reply** unless an outbound idempotency key is added (unspecified). |

### The cheap alternative (if insurance is wanted now)

A **single global reply-worker cap** across the existing pipe/listener/cold-spawn
paths, reusing `ComputeMeter`'s existing global session accounting + the existing
`inbox.jsonl.active` seam: after the warrants gate, if global Threadline reply
workers ≥ `maxConcurrentReplyWorkers`, enqueue + return instead of spawning. ~30–50
lines + tests, no new SPOF, no reply-path rewrite, no `humanInLoop` dependency,
instant rollback — and it delivers the exact "volume no longer maps 1:1 to live
workers" protection the keystone claims, at a fraction of the risk. (Note: even
this should fix the dead warm-listener branch so the enqueue actually drains.)

## Recommendation

**Defer CMT-493** until a real scale signal (≥3 active peers, or a measured
spawn-contention / runaway incident). Keep it tracked. If the operator wants
insurance now, build the cheap global reply-worker cap as a small, low-risk slice
(and fix the dead warm-listener black-hole branch as part of it).

This is the convergence process working: it caught that the largest phase is
speculative under current load, that its "seeds" include dead code, and that a
30-line alternative captures the value — before any code was written.
