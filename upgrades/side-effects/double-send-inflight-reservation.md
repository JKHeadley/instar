# Side-Effects Review — Double-send in-flight reservation (close the exact-duplicate send race)

**Version / slug:** `double-send-inflight-reservation`
**Date:** `2026-07-03`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `reviewer subagent (see appended concurrence)`

## Summary of the change

Closes a check-then-send race in the existing EXACT-match outbound duplicate guard (`OutboundContentDedup`) at the `/telegram/reply` chokepoint. The guard recorded a fingerprint only AFTER a successful send, leaving a window: under a server stall a send can be in flight for tens of seconds, and a second identical request arriving in that window passed the pre-check (nothing recorded yet) and sent a duplicate — one mechanism behind the user-reported double-sends (RCA topics 30823/30837).

The fix adds an atomic **reserve → confirm/release** lifecycle to the SAME exact-match guard:

- `OutboundContentDedup.tryReserve(topicId, text)` — synchronously re-checks the sent-window AND claims an in-flight reservation in one step; returns `false` (suppress) if the text was already sent within the window OR is currently reserved (in flight). Reservations auto-expire after `reserveTtlMs` (default 3min) so a leaked claim can never permanently suppress a fingerprint.
- `OutboundContentDedup.releaseReservation(topicId, text)` — clears the reservation when the send FAILS, so the legitimate retry is not suppressed.
- `record()` (unchanged call site) now also clears the reservation on success (the longer sent-window takes over).

Route wiring (`src/server/routes.ts`, `/telegram/reply`): the cheap `isDuplicate` pre-check before the tone gate is unchanged (early exit for already-sent duplicates); a new `tryReserve` gate is taken AFTER the tone gate, immediately before the send, and `releaseReservation` is called in the send-failure catch. `allowDuplicate` bypasses the reservation entirely.

Files: `src/messaging/OutboundContentDedup.ts`, `src/server/routes.ts`, plus unit + route tests.

## Decision-point inventory

- `OutboundContentDedup` (exact-match duplicate guard) — modify — adds an in-flight reservation phase to an EXISTING deterministic block. It is NOT a new decision point; it makes the existing one race-safe.
- `/telegram/reply` send path — modify — the reservation gate is taken before the send and released on failure.

The reservation is placed AFTER the tone gate, so a held/blocked message never reserves (no interaction with the tone gate's own retry/hold path).

---

## 1. Over-block

**What legitimate inputs does this reject that it shouldn't?** Only an EXACT (whitespace-normalized) duplicate of a message currently in flight to the SAME topic. Concretely: if the agent deliberately sends the byte-identical long message twice to the same topic within ~3 minutes while the first is still sending, the second is suppressed. That is the intended behavior and the existing guard already suppresses the same text once recorded — this only extends it to the in-flight window. Legitimate repeats are protected three ways: (a) brief acks (< `minLength`, default 40) are never reserved or suppressed; (b) `allowDuplicate: true` bypasses it; (c) a DIFFERENT (even slightly reworded) message has a different fingerprint and is never touched. The reworded double-send is explicitly NOT addressed here (see §2) precisely to avoid the brittle-similarity over-block the signal-vs-authority principle warns against.

---

## 2. Under-block

**What failure modes does this still miss?** (a) The **reworded** near-duplicate — a resend with changed wording has a different fingerprint and is NOT caught. This is deliberate: catching it requires a similarity threshold, which is a brittle detector that must NOT hold blocking authority (`docs/signal-vs-authority.md` uses this exact example). That case stays a signal to the tone-gate authority and is routed to a proper spec, not this quick-win. (b) A **cross-process/cross-machine** in-flight race (a durable-relay retry from a different process while the first is in flight) — the in-memory reservation is per-process; once the first send records, the existing durable sent-window store catches the retry, but the sub-second cross-process in-flight window is not closed here. Both are named, not silently deferred: the reworded/systemic case is the RCA's shared-primitives spec work (topic 30837); the cross-process reservation is a follow-up tracked below.

<!-- tracked: topic-30823 — reworded near-dup + cross-process in-flight reservation are follow-ups; the reworded case requires the signal-vs-authority-compliant design in the sibling RCA's shared-primitives spec (topic 30837), NOT a brittle hard block here. -->

---

## 3. Level-of-abstraction fit

Correct layer. The reservation lives INSIDE `OutboundContentDedup` (the class that owns the exact-match guard), so it composes with the existing sent-window logic and durable store rather than being bolted onto the route. The route only sequences reserve → send → confirm/release. This is a deterministic guard becoming race-safe — not a new authority and not a re-implementation of one.

---

## 4. Signal vs authority compliance

**Compliant — and deliberately so.** The reservation strengthens an EXISTING deterministic, EXACT-match block (fingerprint equality) by closing a TOCTOU race. It introduces NO brittle/similarity logic and NO new blocking authority. The reworded near-dup — the case that WOULD require a brittle similarity detector — is explicitly kept OUT (it stays a signal to the tone-gate authority), directly honoring `docs/signal-vs-authority.md`'s canonical warning that a similarity score must not hold blocking authority. This change is the principle-compliant half of the double-send fix.

---

## 5. Interactions

- **Tone gate:** the reservation is taken AFTER the tone gate, so a held/blocked message never reserves — no leak on the tone-gate hold/retry path.
- **Durable sent-window store:** `tryReserve` calls `isDuplicate`, which already consults the durable store; the reservation is additive (in-memory in-flight only) and never conflicts with the recorded sent-window.
- **`record` on success / `releaseReservation` on failure / TTL expiry** form a complete lifecycle — every reserved fingerprint is resolved (success clears, failure clears) or auto-expires; no path leaks a permanent suppression.
- **`allowDuplicate`** short-circuits before `tryReserve` (no reserve, no block), preserving the escape hatch.
- No double-fire with the delivery-id LRU or the byte-identical pre-check — they suppress different windows and all return the same `suppressedDuplicate: true` shape.

---

## 6. External surfaces

- **`/telegram/reply`** — same response shape. A suppressed in-flight duplicate returns `{ ok: true, suppressedDuplicate: true }` (identical to the existing byte-identical suppression). No new error surface; a genuine send failure still returns 500 (and now releases the reservation).
- Behavior depends on timing (in-flight window) by nature — but the outcome is deterministic given fingerprint equality; the TTL bounds any timing dependence.
- No change visible to other agents/users beyond fewer duplicate messages.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local (in-flight state) BY DESIGN, with a named cross-machine follow-up.** The in-flight reservation is per-process in-memory — correct, because the send it guards executes in THIS process. The already-shipped durable `OutboundDedupStore` handles the cross-restart / cross-process SENT-window (once a send records). The remaining sub-second cross-process in-flight window (a durable-relay retry on another machine racing this process's in-flight send) is NOT closed here and is tracked (§2). On a single-machine agent there is no cross-process race and the fix is complete. No user-facing URL/topic-transfer concerns.

---

## 8. Rollback cost

Low. Two files; straight revert restores the prior record-after-success behavior with no data migration (reservations are in-memory only — nothing persisted). The reservation is bypassable at runtime via `allowDuplicate` per-call, and the whole guard is disable-able via `outboundContentDedup.enabled: false` in config. If the reservation were ever suspected of wrongly suppressing, `reserveTtlMs` can be lowered (or the guard disabled) without a code change.

---

## Second-pass review (independent reviewer subagent)

**Concur with the review.** Line-by-line audit of the delivery path confirmed no over-block:

- `tryReserve` is taken strictly AFTER the tone-gate early-return, so a held/blocked message NEVER reserves — the leak-that-would-suppress-the-retry path does not exist.
- No `await`/`return` sits between `tryReserve` and the awaited `sendToTopic`; the reserve→send is effectively atomic and any throw lands in the catch which calls `releaseReservation`. Failed send → reservation released → retry passes (confirmed by route test).
- A leaked reservation (crash before resolve) is freed by `reserveTtlMs` (3min) via the expiry check + `pruneReserved`.
- `!allowDuplicate &&` guards both the pre-check and `tryReserve`; below-`minLength` acks are never reserved.
- `tryReserve`/`releaseReservation`/`record`/`pruneReserved` have no await between check and claim (single-threaded atomic), correct TTL math, per-topic isolation, bounded map growth.
- Signal-vs-authority: only the exact fingerprint-equality guard gained the in-flight phase; no similarity logic gains blocking authority (reworded case deliberately excluded).

**Pre-existing, out-of-scope observations (NOT introduced by this change, NOT blocking):** (1) `record()` fires after any non-throwing `sendToTopic` regardless of whether `sendResult.messageId` indicates real delivery — a relay that "succeeds" without delivering could record+suppress a later legitimate resend; this predates the reservation work. (2) `reserveTtlMs` (3min) correctly stays above the outbound send budget (tone-gate rate-limit wait ≤120s).

<!-- tracked: topic-30823 — pre-existing observation: record()-after-non-throwing-send ignores messageId; a non-delivering "success" could suppress a later resend. Predates this change; folds into the RCA shared-primitives spec (topic 30837) alongside the reworded/cross-process work. -->
