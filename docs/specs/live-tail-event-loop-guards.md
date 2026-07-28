---
title: Live-Tail Event-Loop Guards — stop the holder's tick from freezing the server
status: converged
tier: 2
parent-principle: "Notice + Solve Inefficiencies — Efficiency Is a Standing Search"
review-convergence: self-converged against the measured 2026-06-05 live incident (151 event-loop gaps >5s in 10min, sample traces, Mini 403 storm) + line-level code read of LiveTailSource/TelegramAdapter/server.ts wiring; behavioral change confined to cost/cadence of an existing pipeline, validated by an independent second-pass reviewer (CONCUR) incl. the real two-server handoff e2e.
approved: true
---

# Live-Tail Event-Loop Guards — stop the holder's tick from freezing the server

> Approval ground: Justin's standing direction in topic "Resource Limitation
> Mitigation" (2026-06-05) — explicit preapproval for the resource-stability
> work ("you have my preapproval for this work"), "please proceed as you best
> see fit," and the same-day direction to continue the loop-overload fixes
> ("I'd like to continue working on the issues here… we need mechanisms in
> place where this is more stable"). The merge itself still gates on his word.

**Status:** implemented (this PR)
**Date:** 2026-06-05
**Incident:** 2026-06-05 Laptop meltdown — `[telegram:18423 "Resource Limitation Mitigation"]`
**Related:** `docs/specs/age-kill-backoff.md` (the sibling loop fixed the same day), spec §8 G3b (live-tail streaming)

## The incident (measured, not theorized)

On 2026-06-05 the echo server's event loop blocked for 5–40 seconds repeatedly — 151
gaps >5s in ~10 minutes of `server.log` timestamps. `sample` traces showed timer
callbacks inside giant string serialization (live-tail full-tail payload builds).
The blocked loop had a self-amplifying consequence chain:

1. Event loop frozen → outgoing mesh RPC *timestamps* go stale before the request
   is even sent.
2. The standby (Mac Mini) correctly rejects them (`stale-timestamp`, 403) per
   `meshRpcClockToleranceMs`.
3. The live-tail source treats the rejected flush as "retry next tick" — every
   `liveTailPushRateMs` (5s), forever — including "content diverged — resending
   full tail" resends.
4. The retries add more serialization work to the already-blocked loop → more
   staleness → more rejects → more retries. The operator experiences "machine
   under extremely heavy load, messages having trouble getting sent."

## Root cause

`LiveTailSource.pushTick()` (driven every `liveTailPushRateMs`, default 5s, while
holding the lease) called `getTopicContent(topic)` for **every known topic on
every tick**. The server's content provider resolves that via
`TelegramAdapter.getTopicHistory(topic, 500)`, which **synchronously read and
parsed the entire JSONL message log (up to 75,000 lines / ~20MB) per call**.

N live topics × full-file synchronous read × every 5 seconds, all on the event
loop. The change-detection model was inverted: the source built the full content
*in order to discover* nothing had changed.

Secondary defect: a rejected/unreachable flush was retried at full tick rate with
no backoff — correct state-keeping (never advance `seq`/`streamed` on failure),
but pathological cadence against a persistently-rejecting peer.

## Design — three guards plus a cache

All guards live where the cost is generated; none change WHAT the standby
eventually receives, only how much work it costs to keep it current.

### Guard 1 — version gate (`LiveTailSource` + `TelegramAdapter`)

`TelegramAdapter` keeps a per-topic monotonic `topicContentVersion` counter,
bumped in `appendToLog` (the single funnel every logged message passes through,
both shared-logger and legacy paths). `getTopicContentVersion(topicId)` exposes
it; equal versions ⇒ byte-identical tail content.

`LiveTailSource` takes an optional `getTopicVersion` dep (wired in `server.ts`).
A topic whose version is unchanged since its last successful flush (or last
confirmed identical-content no-op) is skipped **without calling
`getTopicContent`**. Idle topics now cost one Map lookup per tick. A pending
failed send overrides the gate (the version is unchanged since the failed
attempt, but the retry is still owed).

Omitting the dep preserves the pre-fix behavior exactly (tests, other channels).

### Guard 2 — failure backoff (`LiveTailSource`)

On a failed broadcast the source records a per-topic consecutive-failure count
and a next-attempt time: `min(failureBackoffBaseMs × 2^(n−1), failureBackoffMaxMs)`
(defaults 5s base, 5min cap). A topic inside its window is skipped outright. A
success clears both. State-keeping is unchanged — `seq`/`streamed` still never
advance on failure, so the eventual retry carries the same delta (the standby
buffer dedups on seq).

### Guard 3 — content cap (`LiveTailSource`)

A single flush's content is capped at `maxFlushBytes` (default 256 KiB — matching
the standby `LiveTailBuffer.maxBytesPerTopic` ceiling). An oversized delta or
divergence full-resend sends only the freshest suffix; `streamed` still advances
to the full content so the next tick is a clean no-op. The standby caps per-topic
bytes anyway, so the uncapped send was pure cost with no retention benefit.

### The cache — `TelegramAdapter` topic tail cache

`getTopicHistory` is now served from an in-memory per-topic tail (most recent
≤500 entries, the production-caller ceiling — live-tail and the handoff hash use
500, respawn history far less):

- **Batch seed:** on the first cache miss, ONE file pass seeds every live topic
  (`topicToSession` — exactly the set the live-tail streamer enumerates). Without
  this, the first tick after boot would still trigger one full-file scan per topic.
- **Maintenance:** `appendToLog` appends to any seeded topic's tail (capped, FIFO).
- **Lazy fallback:** a non-live topic (e.g. respawn history for an unregistered
  topic) gets a one-time per-topic scan, then is cached.
- **Oversized requests** (limit > 500 — no production caller) bypass the cache.
- **Rotation-safe:** rotation drops only OLD lines; the cache holds only the newest.
- **Compat:** the scan now accepts both `topicId` (legacy writer) and `channelId`
  (shared `MessageLogger` writer) line shapes — the same compat dance
  `MessageLogger.search` already does — so the seed sees every writer's entries.

**Correctness bar:** cache-served history must be byte-equivalent to a fresh file
scan — the cross-machine handoff hash (`hashTopicHistory`) is computed from
`getTopicHistory` on both machines. Pinned by a dedicated parity test.

### The handoff path forces

`handoffSentinelBootWiring` drives its pre-manifest flush with
`pushTick({ force: true })`: a handoff is a deliberate one-shot that must attempt
NOW — the version gate and the backoff window are bypassed (a mid-backoff topic
would otherwise silently drop from the handoff manifest). Unchanged content still
sends nothing. Pinned in the boot-wiring test.

## What this does NOT change

- WHICH content the standby converges to — only the cost/cadence of getting there.
- The mesh clock-tolerance rejection itself (the 403s were the *correct* response
  to genuinely stale timestamps; the defect was upstream).
- The sync child-process spawns observed in other timer ticks (reaper/backstop
  `execSync` paths) — separate subsystem, tracked as follow-up in the
  multi-machine loop-safety audit <!-- tracked: CMT-1109 --> (topic "Resource
  Limitation Mitigation").

## Test coverage

- `tests/unit/LiveTailSource.test.ts` — all pre-existing delta/divergence/
  reconstruction pins, plus: version gate skips without content build; version
  bump re-opens; identical-content no-op records the version; pending retry
  overrides the gate; exponential backoff cadence; backoff cap; success clears
  backoff; cap sends freshest suffix and advances state; force bypasses gate +
  backoff; force still no-ops on identical content.
- `tests/unit/TelegramAdapter-topicTailCache.test.ts` — version counter
  semantics; cache serves without per-call file reads (spy-pinned); limit
  semantics; lazy seed from a prior process's JSONL; single-pass batch seed
  (read-count pinned); shared-writer `channelId` compat; 500-entry cap;
  cache-vs-file byte parity (the handoff-hash bar).
- `tests/unit/live-tail-version-gate-wiring.test.ts` — wiring integrity: the
  server boot passes `getTopicVersion` through (the fix cannot be "constructed
  but inert"), and the handoff wiring forces.
- `tests/unit/handoff-sentinel-boot-wiring.test.ts` — updated pin: the handoff
  flush is `pushTick:force`.

## Rollback

Pure in-process change, no persistent state, no config migration. Revert the
commit and ship a patch. (No per-agent dial is exposed deliberately — the pre-fix
behavior is a measured pathology with no legitimate operating point; tests that
need it omit `getTopicVersion`.)
