# Side-Effects Review — Throughput completion count and climbing trend

**Version / slug:** `throughput-count-climbing`  
**Date:** `2026-07-21`  
**Author:** `instar-codey`  
**Second-pass reviewer:** `/root/goal4_decision_grading/throughput_second_pass — CONCUR` (migration safety, lifecycle idempotency, schema-v2 mixed-version honesty, semantic sanitizer integrity, and zero action authority)

## 1. Decision points

Persisted `delivered` events enqueue one completion row. Startup reconciliation replays delivered commitments using the same stable opaque identity, so a crash can delay but not multiply the count. Complete UTC days are split oldest/newest; the current partial day is excluded and zero days remain visible. Schema-v1 peers are reported unsupported after the response advances to schema 2.

## 2. Signal versus authority

The count and direction are descriptive only. They cannot select work, grade a worker, notify anyone, impose a floor, block a route or merge, or mutate a commitment. The observe-only throughput floor from #1533 remains observe-only. Reference: `docs/signal-vs-authority.md`.

## 3. Failure and degradation

Ledger unavailability still makes only metric reads unavailable; commitment delivery succeeds independently. Queue loss is repaired by bounded reconciliation. Invalid or legacy peer bodies are excluded with an honest failure reason, never coerced to zero. An invalid delivery timestamp produces no row rather than an invented time.

## 4. State and migration

The existing SQLite table is migrated in-place to widen its closed factor check while preserving all rows and indexes. Fresh databases create the widened schema directly. The new rows contain origin, opaque source id, timestamp, and outcome only—no user text or commitment content.

## 5. Multi-machine behavior

Each origin counts its own authoritative commitment deliveries. Pool reads retain per-origin values and never create a fleet aggregate. Mixed versions are explicitly unsupported until upgraded; no old peer is interpreted as having zero completions.

## 6. Privacy and external surfaces

No new endpoint, export, notice, or third-party call is added. Existing authenticated `/blocker-lifecycle/summary` and `/trend` responses gain the count factor. Source ids are one-way hashes over origin and commitment id.

## 7. Rollback

Reverting the event consumer and response factor stops new reads without affecting delivery authority. Existing completion rows and the widened SQLite check remain inert and safe; destructive down-migration is neither needed nor attempted.

## 8. Verification and second pass

Unit tests pin dedupe, migration, event counting, and climbing math. Integration pins restart reconciliation and idempotency. E2E-alive boots the real server and reads exact count 16 plus a 4x climbing trend through authenticated routes. Independent second-pass review confirmed lifecycle ordering, migration safety, mixed-version honesty, semantic cross-machine validation, and absence of action consumers before merge.

Post-rebase integration with the recurring maturation evaluator now includes `deliverable-completion` in its typed summary/trend maps and uses count totals as trend sample evidence. A focused maturation test proves a completion-rate contract evaluates from this shared substrate; no parallel evaluator or authority was introduced.
The independent reviewer rechecked this D7 composition and concurred: completion counts and latency samples remain correctly distinguished, zero semantics are preserved, and readiness requires a real persisted completion.
