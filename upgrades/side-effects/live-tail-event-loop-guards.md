# Side-Effects Review — Live-Tail Event-Loop Guards

**Version / slug:** `live-tail-event-loop-guards`
**Date:** `2026-06-05`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `independent reviewer subagent — CONCUR (one non-blocking memory-retention fix + two doc-precision notes, all applied)`

## Summary of the change

The multi-machine live-tail streamer (`LiveTailSource.pushTick`, every `liveTailPushRateMs`=5s while holding the lease) rebuilt EVERY known topic's content EVERY tick, and the Telegram content provider (`TelegramAdapter.getTopicHistory`) resolved each rebuild with a synchronous full read of the JSONL message log (≤75k lines) — measured on 2026-06-05 as 5–40s event-loop blocks that went on to stale mesh timestamps → standby 403s → tick-rate hot retries (a self-amplifying storm). This change adds: a per-topic monotonic content version (`TelegramAdapter.appendToLog` bump → `getTopicContentVersion`) consumed by `LiveTailSource` as an optional `getTopicVersion` dep so unchanged topics are skipped WITHOUT building content; an in-memory per-topic tail cache behind `getTopicHistory` (single-pass batch seed of all live topics, maintained on append, lazy per-topic fallback, reclaimed on `unregisterTopic`); exponential per-topic failure backoff (5s base ×2 → 5min cap) replacing tick-rate retries; a 256KiB per-flush content cap (freshest suffix); and a `{ force: true }` handoff path that bypasses gate+backoff (`handoffSentinelBootWiring`). Files: `LiveTailSource.ts`, `TelegramAdapter.ts`, `handoffSentinelBootWiring.ts`, one wiring line in `server.ts`, four test files.

## Decision-point inventory

- `LiveTailSource.flushTopic` — **modify** — adds skip conditions (unchanged version / inside backoff window) and a size cap; the delta-accounting model (never advance `seq`/`streamed` on failure) is unchanged.
- `TelegramAdapter.getTopicHistory` — **modify (transparent)** — same results, served from memory; byte-parity with a fresh file scan is test-pinned (the handoff hash depends on it).
- `TelegramAdapter.appendToLog` — **modify (additive)** — bumps the version counter + maintains the cache before either persistence path; persistence behavior unchanged.
- `handoffSentinelBootWiring.pushTick` — **modify** — forces (gate/backoff bypass) so a handoff manifest can never silently drop a mid-backoff topic.
- `LiveTailSource` backoff ledger — **add** — a pure cadence suppressor; holds no authority over WHAT is eventually streamed.

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

Nothing is rejected — only deferred or trimmed, all bounded: (a) a topic mid-backoff delays its retry ≤5min (cleared instantly on any success; bypassed entirely by the handoff force path, so a planned handoff can never be starved by the window); (b) the version gate skips only topics whose version — bumped by the single funnel every logged message passes through — is unchanged, and an identical-content no-op records the version only after byte-comparing the real content; (c) the 256KiB cap trims a flush to its freshest suffix — the standby's `LiveTailBuffer` enforces its own independent per-topic byte cap, and the reviewer verified `getTail()` currently has no consumer (post-failover history is reconstructed from each machine's own message log, not the buffer), so trimmed middle bytes have no downstream reader today.

## 2. Under-block

**What failure modes does this still miss?**

(a) The mesh-RPC clock-tolerance rejection itself is untouched (correct behavior; the defect was upstream). (b) Sync child-process spawns in OTHER timer ticks (reaper/backstop `execSync` paths) remain — separate subsystem, explicitly tracked as follow-up in the multi-machine loop-safety audit <!-- tracked: CMT-1109 --> (topic "Resource Limitation Mitigation"). (c) The backoff is per-topic, not per-peer: with many topics all failing against one dead peer, first-attempt cost is still N serializations once per window — bounded by the cap and far below tick-rate, acceptable. (d) `maxFlushBytes` counts UTF-16 chars, not UTF-8 bytes (≈3× under-count for heavily non-ASCII content) — sender-side cost bound only; the standby caps independently (doc-noted per reviewer).

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. Each guard sits exactly where its cost is generated: the version signal lives in the adapter that owns message logging (the only component that KNOWS when content changes); the gate/backoff/cap live in the source that generates the serialization work; the cache lives behind the existing `getTopicHistory` contract (every consumer — respawn history, handoff hash, live-tail — speeds up without knowing). No new authority, no new config surface, no parallel mechanism duplicating the standby buffer's own caps. The backoff mirrors the established suppressor shape (`AgeKillBackoff`, `AttentionTopicGuard`): pure logic, injectable clock, bounded state.

## 4. Signal vs authority compliance

**Required reference:** `docs/signal-vs-authority.md`

- [x] No — this change produces/consumes signals (a change counter, a "skip until" window, a size bound) inside an existing data-freshness pipeline; it holds NO authority over sessions, leases, kills, or message delivery.

The version counter cannot suppress a real change (every logged message bumps it; the reviewer traced all ingress/egress paths through `appendToLog`). The backoff cannot drop content (state never advances on failure; the owed delta sends when the window opens or a handoff forces). The cap cannot starve the standby (its own buffer cap is lower-or-equal in practice). Lease/handoff authority is untouched.

## 5. Interactions

- **Handoff hash parity (the critical one):** both machines hash their OWN `getTopicHistory(topic, 500)`. The cache stores the same entry objects the file receives, in the same order (append updates both in one synchronous call; the seed reads file order). Reviewer confirmed `hashTopicHistory` reads only `timestamp` + `text` (primitive strings in every shape) and ran the real two-server `planned-handoff-e2e` — including the hash-mismatch abort path — green through the cache.
- **Version capture timing:** `version` is captured in `flushTopic` together with the content build (no `await` between them) and recorded only on success — a message arriving during the `await broadcast` bumps the live counter ABOVE the recorded snapshot, so the next tick correctly re-opens. (Reviewer probed this specifically.)
- **Double-fire / races:** the cache+counter are plain in-process Maps touched only from synchronous adapter calls; `seedTailCacheFromLog` is fully synchronous (no event-loop yield between read and `tailCacheSeeded=true`), so no append can fall between seed-read and cache-live. Appends during a broadcast `await` land in the seeded cache and bump the version consistently.
- **Feedback loops:** the change only REMOVES a feedback loop (frozen loop → stale timestamps → rejects → hot retries → more freeze). Skipping/deferring work cannot trigger more work.
- **Shadowing:** force on the handoff path ensures the new skip conditions can never shadow the handoff manifest's freshness requirement (test-pinned `pushTick:force`).

## 6. External surfaces

- **Other agents / users:** behavior ships fleet-wide on update; observable change is fewer event-loop stalls, fewer mesh 403 storms, fewer log lines ("not acknowledged — will retry" now carries a backoff horizon, plus capped/truncation lines). No API, schema, or message-shape change.
- **External systems:** none beyond the existing machine-to-machine live-tail channel (same wire format, same encryption; only cadence + max size change).
- **Persistent state:** none. Counter + cache + backoff ledger are in-memory; nothing written to disk; no migration. (Migration Parity: nothing to migrate — defaults live in code.)
- **Timing:** standby copy freshness for a FAILING peer degrades from "retry every 5s" to "retry ≤5min" — the deliberate trade; a HEALTHY peer's freshness is unchanged (new content still flushes on the next tick).

## 7. Rollback cost

Pure in-process code change. Revert the commit and ship a patch. No persistent state to clean, no config to unwind, no schema. Per-component soft-disable exists naturally for tests (omit `getTopicVersion` → pre-fix gating behavior); no operator dial is exposed deliberately — the pre-fix behavior is a measured pathology with no legitimate operating point.

## Conclusion

The review confirmed the three invariants that matter: (a) the standby converges to the SAME content as before — only the cost/cadence of getting there changes (handoff-hash parity test-pinned and e2e-verified); (b) no authority moved — every new mechanism is a bounded cadence/size signal inside an existing pipeline; (c) rollback is a trivial revert with zero persistent state. One reviewer finding changed code: `unregisterTopic` now reclaims the topic's tail cache (long-lived servers churning topics must not retain ≤500 entries per topic forever) — the version counter is deliberately retained (~8 bytes) to avoid a re-registration version-collision against `lastSeenVersion` snapshots.

---

## Phase 5 — Second-pass review (cross-machine continuity change → performed)

An independent reviewer subagent audited the staged diff, the final files, the spec, and the wiring at line level, specifically probing: handoff-hash divergence through the cache (including entry order, JSON round-trip shape, and the `channelId` compat path), version-gate miss scenarios (other writers, rotation, multi-instance), cache coherence windows, backoff-vs-gate retry semantics and version-capture timing, content-cap interaction with the delta model and `LiveTailBuffer` semantics, memory bounds, the force chain, and ran the unit + neighbor + real two-server handoff e2e suites (all green, tsc clean).

**Verdict: CONCUR.** No blocking defects. Three non-blocking findings, all addressed: (1) `unregisterTopic` did not reclaim the tail cache → fixed (cache deleted on unregister; counter deliberately kept, with the collision rationale documented inline); (2) the `maxFlushBytes` chars-vs-bytes approximation overstated "matching the standby ceiling" → comment and this artifact corrected to "sender-side cost bound; standby caps independently"; (3) the cache-vs-file parity test is stricter than the hash requires and would read as a false regression if the shared-MessageLogger flag ever flips → scope-noted in the test.

**Post-CI note (same day):** shard-3 ratchet (no-silent-fallbacks) flagged the seed's per-line malformed-JSONL skip (460 > 459 baseline); annotated `@silent-fallback-ok` inside the catch per the report-or-exempt rule — identical deliberate behavior to the scan path's long-standing skip.
