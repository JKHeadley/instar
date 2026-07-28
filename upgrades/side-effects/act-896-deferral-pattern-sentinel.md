# Side-Effects Review — ACT-896 deferral pattern sentinel

**Version / slug:** `act-896-deferral-pattern-sentinel`
**Date:** `2026-07-22`
**Author:** `Instar-codey Stream 2`
**Second-pass reviewer:** `Codex independent reviewer (act896_second_pass)`

## Summary of the change

`src/monitoring/DeferralPatternSentinel.ts` adds increment 1 of a pure, injected,
dark-by-default and dry-run-first pattern sentinel. It consumes the canonical
`detectDeferralShape()` result already stored as `deferralShapeDetected` in
tone-decision provenance, counts recent distinct positive candidate identities,
and produces one stable deduped Attention input at threshold. It adds no matcher,
store, route, timer, or boot wiring. `JudgmentProvenanceLog` gains a narrow
machine-local typed projection over those existing rows; no full context or text
leaves that store.

## Decision-point inventory

- `DeferralPatternSentinel.tick()` — add — decides whether accumulated,
  identity-only observations constitute a pattern signal; it never blocks,
  rewrites, delays, or otherwise controls an outbound message.
- Dry-run/live emission branch — add — dry-run audits only; live calls the
  injected Attention sink with a stable idempotency key.

---

## 1. Over-block

No block/allow surface — over-block not applicable. A false positive can create an
Attention item only after the live posture is deliberately enabled; increment 1 is
not wired and the default is dry-run.

---

## 2. Under-block

The sentinel misses semantically equivalent deferrals the canonical recognizer
does not detect, observations outside the configured window, and repeated
deferrals with byte-identical candidate hashes. The last exclusion is intentional:
replayed provenance rows must not manufacture a pattern.

---

## 3. Level-of-abstraction fit

This is an aggregate signal producer above the existing low-level recognizer and
existing provenance store. It does not duplicate either. Its output feeds the
existing Attention authority/funnel through an injected callback in a later wiring
increment.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

The deterministic threshold creates an operator-visible signal only. It has no
authority over messaging or agent action.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No static heuristic is added at a competing-signals decision point. The threshold
only determines when accumulated observations are worth surfacing; it does not
judge whether any individual deferral was wrong and the Attention body says so.

---

## 5. Interactions

- **Shadowing:** none; the canonical recognizer remains the sole matcher.
- **Double-fire:** the stable `premature-deferral-pattern` key lets the existing
  Attention store coalesce repeated live ticks into one item.
- **Races:** increment 1 owns no mutable shared state or timer; observations arrive
  as an injected snapshot and are deduped locally by candidate hash.
- **Feedback loops:** Attention output is not fed back into tone provenance.

---

## 6. External surfaces

No external surface is boot-wired in increment 1. The only durable data it is
designed to read already exists in tone-decision provenance. The status snapshot
contains aggregate counts and timestamps only, never message text or hashes.
There are no operator-facing actions.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design for increment 1: it reads each machine's existing,
machine-local tone provenance through a new content-free internal projection.
A later wiring increment must choose a one-voice owner for Attention emission;
increment 1 emits no notice, strands no new durable state, and generates no URL.

---

## 8. Rollback cost

Revert the module, tests, and internal release fragment. There is no migration,
new persistent state, live registration, or agent-state repair.

---

## Conclusion

The design closes the requested increment without widening authority: canonical
recognition and storage stay canonical, aggregation is pure and content-free,
and every active surface remains injected and inert until a separately reviewed
boot-wiring increment.

---

## Second-pass review (if required)

**Reviewer:** Codex independent reviewer (`act896_second_pass`)
**Independent read of the artifact:** concur

The reviewer confirmed signal-only authority, pure/injected construction, dark
default, dry-run-first behavior, boundary coverage, and absence of boot wiring.
It asked that the artifact state two seams precisely: repeated live callback
invocations rely on the existing Attention funnel for durable one-item
idempotency, and the provenance store needed a typed internal projection. Both
are now explicit, and the latter was added to `JudgmentProvenanceLog`.

---

## Evidence pointers

- `tests/unit/DeferralPatternSentinel.test.ts`
- `tests/unit/deferral-floor.test.ts`
- `tests/unit/tone-gate-deferral-provenance.test.ts`
- `tests/unit/JudgmentProvenanceLog.test.ts` (canonical-store projection)
- `tests/unit/no-silent-fallbacks.test.ts` (absent/unreadable observability files
  are explicitly classified and do not raise the repository fallback baseline)

---

## Class-Closure Declaration (display-only mirror)

**`defectClass`:** `unbounded-self-action`

This sentinel's possible self-action is a request to create one deduped
notification. The control-loop
edge is `existing provenance snapshot → threshold signal → Attention idempotency
key`. Repeated live ticks may call the injected sink, so the one-item steady-state
bound is conditional on the later adapter preserving that stable key through the
existing Attention idempotency funnel. Dark and dry-run are settling brakes, and
increment 1 has no timer or boot edge at all. The ratchet is
`tests/unit/self-action-convergence.test.ts`.

- **`guardEvidence.howCaught`:** unit tests prove strict dark no-read, dry-run
  no-emission, and a stable dedupe key across counts/ticks; the existing Attention
  funnel provides durable idempotency when wired.
- **`structuralGuard`:** canonical recognizer import boundary plus injected
  `raiseAttention` and stable `DEFERRAL_PATTERN_DEDUP_KEY`.
- **`classClosed`:** yes for increment 1's shipped posture because there is no
  autonomous trigger or boot edge. Live class closure must be re-proven by the
  wiring increment against the real Attention idempotency funnel.
