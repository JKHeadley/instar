# Side-Effects Review — durable outbound content-dedup (cross-restart)

**Version / slug:** `durable-outbound-dedup`
**Date:** `2026-06-07`
**Author:** `Echo`
**Tier:** 1 (durable backing for an existing dedup; fail-open; no API/route/config/migration surface; both-sides tested)
**Second-pass reviewer:** `Echo (self) — Tier-1; the fail-open design is the load-bearing safety property and is directly tested`

## Summary of the change

Fixes the cross-restart duplicate-reply bug (topic 21816,
finding_cross_restart_duplicate_replies): during the "server temporarily down"
restart instability a byte-identical refusal went to the same topic **5× in 19s**
(confirmed byte-identical by sha). The existing `OutboundContentDedup` couldn't
catch it because its fingerprint Map is **per-process in-memory** and resets on
restart / isn't shared across overlapping processes — exactly the window the
restart churn opened.

Adds `OutboundDedupStore` (`src/messaging/OutboundDedupStore.ts`): a SQLite-backed
durable fingerprint store. `OutboundContentDedup` now takes an optional store —
`isDuplicate` consults it when the in-memory Map misses (catching a duplicate
across a restart), and `record` mirrors to it. Wired in `routes.ts` at the existing
`/telegram/reply` dedup point with `SqliteOutboundDedupStore(stateDir)`.

## The load-bearing safety property: FAIL-OPEN

A dedup that wrongly suppresses a **legitimate** reply is strictly worse than the
duplicate it prevents. So every store method swallows its own errors and returns
"no durable signal" — a missing / locked / corrupt / native-binding-broken db ⇒
silent no-op, the caller behaves exactly as the in-memory-only path did. The
construct path is guarded too (better-sqlite3 binding fragility was itself a factor
in this incident). Directly tested: a throwing store + an unwritable path both
no-op without throwing, and in-memory dedup still works.

## Decision-point inventory

- The only new decision: "was this fingerprint sent recently, per the durable
  store?" — consulted ONLY when in-memory misses, ANDed into the existing window +
  length-floor gates (unchanged). The narrow-by-design protections (≥40 chars,
  `allowDuplicate` escape hatch, record-only-after-success) are all preserved.

## 1. False positive (suppress a legitimate message)

Mitigated three ways: (a) fail-open (any store trouble ⇒ allow the send), (b) the
existing ≥40-char floor + window + `allowDuplicate` escape hatch are unchanged, (c)
fingerprint is (normalized-text + length), so only a byte-identical recent send to
the SAME topic is ever a duplicate. Tested: different text / different topic / past
window are NOT suppressed.

## 2. False negative (still duplicates)

The durable store catches byte-identical re-sends across restarts/processes (the
observed bug). It does NOT catch near-identical *regenerations* (different bytes) —
but the incident's 5 sends were byte-identical (verified), so this is the right
shape. (A deeper inbound "don't re-inject an in-flight message across restart"
guard is noted as a follow-up in the finding; this closes the observed symptom.)

## 3. Blast radius

`/telegram/reply` adds one SQLite point-query per reply (fast; better-sqlite3 is
synchronous + already used widely). A new per-agent `outbound-dedup.db` is
auto-created (no migration). Fail-open bounds worst case to today's behavior. No
config change (reuses the existing `outboundContentDedup` config block).

## 4. Rollback

Pass `null` as the store (or revert the routes wiring) ⇒ in-memory-only (today's
behavior). Delete `outbound-dedup.db` is harmless (auto-recreated). No format/state
migration.

## 5. Tests

`tests/unit/outbound-dedup-durable.test.ts` (6): catches a duplicate across a
restart (fresh instance, same db file — the bug); in-memory still works + length
floor; different text/topic not suppressed; window honored; fail-open on a throwing
store; store fail-opens on an unwritable path. Existing `OutboundContentDedup.test`
(11) still green; no-silent-fallbacks at baseline (fail-open catches marked); tsc clean.
