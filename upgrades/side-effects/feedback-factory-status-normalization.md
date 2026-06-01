# Side-Effects Review — feedback-factory canonical status normalization (Phase 1)

**Slug:** `feedback-factory-status-normalization`
**Date:** `2026-05-31`
**Author:** Echo
**Spec:** `docs/specs/feedback-factory-migration.md` (converged v2, approved by Justin 2026-05-26, topic 12476)
**Second-pass reviewer:** not required (pure additive primitives + one comparator predicate; both-sides-of-boundary unit coverage)
**Scope:** The status-vocabulary normalization primitives in `src/feedback-factory/processor/transitions.ts`, and their application in the Phase-3 parity comparator `src/feedback-factory/processor/parity.ts` (`compareClusterOutcomes`). Driven by Dawn's pinned canonical contract (thread-978f016b): the authoritative `V1_TO_V2_STATUS` (feedback-processor.py:1035) + terminal set (:379) that Portal owns.

## Summary of the change

During the migration, three status vocabularies coexist: the v1 legacy literals Portal still writes (`open`/`fixed`/`resolved`/…), the mid-migration write-gate superset both sides accept, and the canonical v2 lifecycle (`V2_STATES`). The Phase-3 live-mirror parity comparator compared cluster outcome status with a raw `i.status !== p.status`, so an equivalent cluster — Portal `resolved` vs the ported Instar processor's `closed` — read as a **divergence**, which structurally **blocks Phase-4 cutover** (`ParityResult.divergent`). That is benign vocabulary skew being treated as a real history fork.

This change adds three pure primitives to `transitions.ts` — `V1_TO_V2_STATUS` (the v1→v2 projection map), `TERMINAL_STATUSES` + `isTerminalStatus()` (terminal check on the normalized status, incl. the terminal-only `legacy_closed` literal), and `normalizeStatus()` (idempotent v1→v2 projection; already-v2 and unknown values pass through) — and applies `normalizeStatus` to BOTH sides of the status comparison in `compareClusterOutcomes` before the `!==`. Reported divergence values stay raw so the operator still sees each side's actual stored status when a genuine mismatch survives. **No route/job behavior changes** — the parity comparator is exercised by the dry-run runner, and `transitions.ts` is a pure library.

## Decision-point inventory

- `compareClusterOutcomes` status equality (`parity.ts:~155`) — **modify** — now compares in normalized v2 space; recurrence + missing-on-one-side checks unchanged.
- `normalizeStatus` / `isTerminalStatus` / `V1_TO_V2_STATUS` / `TERMINAL_STATUSES` (`transitions.ts`) — **add** — canonical vocabulary primitives mirrored from Portal's reference.

---

## 1. Over-block

The only "block/allow"-like surface here is `ParityResult.divergent`, which gates Phase-4 cutover. **Over-block before this change:** a window where Portal stored `resolved`/`open`/`fixed` and Instar recomputed `closed`/`new`/`fix_applied` for the SAME fingerprint produced a `status` divergence and a red verdict — blocking cutover on noise. This change removes exactly that false block: each v1↔v2 pair now reconciles. It does not newly reject any input — it only stops rejecting vocabulary-equivalent ones.

---

## 2. Under-block

**What real divergence could normalization now mask?** Only a difference that vanishes under the pinned v1→v2 map. The map is a small, fixed bijection on the legacy literals (`open→new`, `fixed→fix_applied`, `resolved→closed`; investigating/wontfix/duplicate identity). A genuine lifecycle mismatch — e.g. Instar `investigating` vs Portal `resolved` (→`closed`) — still differs after normalization and is still flagged (asserted in `parity.test.ts`). Recurrence divergence on a vocabulary-equivalent status is also still flagged (asserted) — normalization touches status only. Risk that the map itself is wrong is contained: it is byte-mirrored from Dawn's owned reference and asserted against drift in `transitions.test.ts`.

---

## 3. Level-of-abstraction fit

Correct layer. `normalizeStatus`/`isTerminalStatus` are pure processor-logic primitives living beside the existing ported lifecycle decision functions (`canTransition`, `detectCycling`) in `transitions.ts` — the same module that already owns `V2_STATES`. The parity comparator is the right and only consumer for the projection at cutover time; it now USES the shared primitive rather than re-encoding status equality. No higher-level gate is bypassed and no lower-level primitive is re-implemented.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface over user/agent messages. `ParityResult.divergent` is a structural equivalence signal consumed by the dry-run/cutover decision (a human-gated process), not an autonomous block on traffic.

`compareClusterOutcomes` is a deterministic comparator over two pre-computed outcome lists; it owns no runtime authority over messages or operations. The normalization makes its signal *more* accurate (fewer false divergences) without granting it new authority. The terminal authority over a cluster's lifecycle remains with the curated cluster history (per the spec's Signal-vs-Authority lesson), untouched here.

---

## 5. Interactions

- **Shadowing:** none. The status branch is independent of the fingerprint invariant (invariant 1) and the recurrence branch; normalization is scoped to the status `!==` only. `missing-instar`/`missing-portal` paths are unchanged.
- **Double-fire:** none. Single comparator, single call site (the dry-run runner).
- **Races:** none. Pure functions over injected snapshots; no shared mutable state.
- **Feedback loops:** none. The comparator reads Portal's read-only snapshot + supplied Instar outcomes and emits a verdict; it writes nothing back into either system.
- **Import graph:** `parity.ts` now imports `normalizeStatus` from `transitions.ts`. `transitions.ts` imports nothing — no cycle introduced (confirmed: `tsc --noEmit` clean).

---

## 6. External surfaces

- **Other agents / install base:** none. Internal feedback-factory library code; not wired to a route or job. No CLAUDE.md-template/hook/config surface touched → no Migration-Parity obligation.
- **External systems:** none. Portal is read-only here; no write path.
- **Persistent state:** none. No schema, ledger, or memory file change. The JSONL audit-trail RECORD shape (`dryRunCompare.toRecords`) is unchanged — the `status` divergence still reports raw values, so existing audit consumers see the same field semantics.
- **Reported-value semantics:** an emitted `status` divergence continues to carry the RAW stored status of each side (not the normalized form), deliberately — so a human reading the audit trail sees what each side actually stored. Documented in code + tests.

---

## 7. Rollback cost

Pure code change — revert the two source edits and ship as a patch. No persistent state, no data migration, no agent-state repair, no user-visible surface. Reverting restores the prior raw `!==` comparison; the only effect of a revert is the re-appearance of vocabulary-skew false divergences in a dry-run (a stricter, not looser, gate — fail-safe direction for a cutover block).

---

## Equivalence verification

- `V1_TO_V2_STATUS` and `TERMINAL_STATUSES` are byte-mirrored from Dawn's pinned authoritative definitions (feedback-processor.py:1035 / :379) and asserted exactly in `transitions.test.ts` (no-drift tests).
- `normalizeStatus` proven idempotent (no v2 output value is itself a re-mapping v1 key) — asserted via double-apply.
- `isTerminalStatus` proven to normalize-before-check: raw v1 `resolved` reads terminal (the load-bearing case); `legacy_closed` is terminal but not a `V2_STATES` member.
- `transitions.ts` change is **purely additive** — `canTransition`/`detectCycling` (the Python byte-parity surface covered by `scripts/feedback-factory/transitions-parity.mjs`) are untouched, so byte-exact parity with the reference is preserved by construction.

## Tests

- **Tier-1 unit (CI):** `tests/unit/feedback-factory/transitions.test.ts` — `normalizeStatus` (each mapping, identity entries, idempotence, already-v2 passthrough, unknown passthrough, exact-map no-drift) and `isTerminalStatus` (every terminal state, the normalize-before-check `resolved` case, non-terminal v1 literals incl. `fixed→fix_applied`, exact-set no-drift, `legacy_closed`). `tests/unit/feedback-factory/parity.test.ts` — each v1↔v2 pair reconciles, direction-agnostic, genuine lifecycle divergence still flagged with RAW reported values, recurrence not masked, and a green `compareInvariants` verdict across a vocabulary-skewed window. **156 feedback-factory unit tests green, `tsc` clean.**
- **Tier-2 integration:** `tests/integration/feedback-factory-process.test.ts` — 4/4 green (no regression in the processing composition).
- **No new E2E tier:** the comparator is not wired to a live route/job — the live dual-forward parity run (the Phase-4 cutover gate) is the operational verification and runs against Portal's `/api/instar/read` via `HttpParitySource`. Reasoned decision, documented.

## Conclusion

This review produced no design change — the projection is the minimal, contract-faithful fix for the false-divergence seam Dawn pinned, scoped precisely to the parity comparator + the shared primitives. The two consumer-side sites that ALSO read raw status literals — `FeedbackStore.getActiveClusters` (`!= 'resolved'`) and `reportPartition` (raw `'open'`/`'fixed'`) — were deliberately left out of this change because the correct fix hinges on the canonical active/merge-candidate query semantics (`!= closed`, faithful to the reference `status != 'resolved'`, vs full `!isTerminal`), which is a bilateral question for Dawn (the domain owner) rather than a guess that could itself introduce a divergence. That open question is being raised to Dawn directly on thread-978f016b. Clear to ship.
