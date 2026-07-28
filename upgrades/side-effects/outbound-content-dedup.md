# Side-Effects Review — Outbound Content-Dedup

**Version / slug:** `outbound-content-dedup`
**Date:** `2026-06-06`
**Author:** `Echo (instar-dev agent — Justin: "We really need to work on not sending duplicate messages. Let's make this much more robust.")`
**Second-pass reviewer:** `self-adversarial pass over the one real risk — suppressing a message the user actually needed`

## Summary of the change

A pure `OutboundContentDedup` (per-topic, windowed, length-gated content
fingerprint) wired at the `/telegram/reply` route, after the delivery-id LRU and
before the tone gate. An identical long message to the same topic within ~15min
is suppressed (200, not re-sent); the first send still goes. Files:
`OutboundContentDedup.ts` (new), `routes.ts` (instance + check/record),
`PostUpdateMigrator.ts` (CLAUDE.md note), 3 test files.

## Decision-point inventory

- content-dedup check — **add (suppress)** — before the send.
- length floor (minLength 40) — **add** — brief acks always pass.
- `allowDuplicate` bypass — **reuse (existing metadata)** — caller can force a repeat.
- record-after-success — **deliberate** — a failed send's retry isn't lost.

## 1. Over-block (the real risk — suppressing a wanted message)

The danger is dropping a message the user needed. Defenses, each tested:
- **Length floor:** brief acks (the most common legitimate repeat — two "Got it"
  for two user messages) are exempt (test: "brief acks never suppressed").
- **Per-topic:** the same text to a different topic sends (tested).
- **`allowDuplicate` escape hatch:** a caller that means to repeat bypasses it
  (tested).
- **Record-after-success:** a send that throws is never recorded, so its
  legitimate retry (same content, new id) is not suppressed.
- **Scope = `/telegram/reply` only:** command responses (bot command handler) and
  sentinel/standby sends go through other paths and are untouched, so a user
  re-running a command still gets fresh output.
Residual: a caller that legitimately re-sends the EXACT same ≥40-char text to the
SAME topic within 15min without `allowDuplicate` is suppressed — which is exactly
the reported bug, and the escape hatch covers the rare intentional case.

## 2. Under-block

Near-duplicates (reworded status, e.g. the 21:15 variant in the incident) are
NOT caught — only byte-identical (whitespace-normalized) text. Catching
semantic near-dups would require an LLM and risks false suppression; the
deterministic exact-match is the safe, robust core. The reworded-variant case is
a separate, lower-frequency concern.

## 3. Level-of-abstraction fit

The dedup is a pure module in `messaging/`, instantiated once per route
construction beside the existing delivery-id LRU (same lifecycle, same
chokepoint). It reuses the route's existing `allowDuplicate` metadata contract.

## 4. Signal vs authority compliance

**Required reference:** `docs/signal-vs-authority.md`

- [x] Deterministic guard, no LLM. It removes a redundant send; it never alters
  content and never blocks a non-duplicate. The `allowDuplicate` hatch preserves
  caller authority for intentional repeats. Strictly subtractive on exact dups.

## 5. Interactions

- **Delivery-id LRU:** complementary — id-dedup catches a re-POST of the same id;
  content-dedup catches a fresh-id re-send of the same text. Runs after it.
- **Tone gate:** the content-dedup runs BEFORE it (so a duplicate skips the LLM
  call entirely) and independent of it (covers the proxy/relay paths the gate
  skips).
- **Tokenless-standby relay:** unaffected — the dedup decides before the send;
  the relay still carries the real messageId on a non-duplicate.

## 6. External surfaces / 7. Rollback

New response field `suppressedDuplicate: true` on a suppressed `/telegram/reply`
(additive; callers `.catch`/ignore the body today). Optional config
`outboundContentDedup` (window/minLength/maxPerTopic/enabled) with safe
defaults; absent ⇒ defaults. One idempotent CLAUDE.md note. Rollback = revert;
duplicates flow again.
