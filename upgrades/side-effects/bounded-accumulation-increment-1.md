# Side-Effects Review — Bounded Accumulation Increment 1 (registry + accessor + 2 lints + rotation fix)

**Slug:** `bounded-accumulation-increment-1` · **Tier:** 2 (spec-driven; converged + operator-approved)
**Spec:** `docs/specs/bounded-accumulation-standard.md` (review-convergence 2026-06-21, approved)

## Summary of the change

The non-behavioral first increment of the Bounded Accumulation standard. It adds the ENFORCEMENT
substrate without changing any existing store's runtime behavior:
- `src/utils/jsonl-rotation.ts`: adds `maybeRotateJsonlSegment` — event-loop-safe segment rotation
  (rename active → numbered segment, fresh active, unlink-oldest; O(1), NO whole-file read). The
  existing `maybeRotateJsonl` (read-filter-rewrite) is left intact but marked non-conformant.
- `src/core/storage/JsonlStore.ts`: the registered accessor funnel — append + a cached-byte-counter
  throttle so even the O(1) statSync isn't paid per append.
- `src/data/state-coherence-registry.json`: extends 10 in-scope entries with a `retention` policy
  (A/C/sqlite/R classes). 75 legacy categories are frozen as the retrofit backlog.
- `scripts/lint-store-retention-declared.js` (Lint 1) + `scripts/lint-no-wholefile-sync-read.js`
  (Lint 2), wired into `npm run lint`, each with a frozen baseline.

## Decision-point inventory

All decisions are frozen in the spec §6 (D1–D9): 32MB/4-segment A-class default, 30-day token-ledger,
compliance-hold (archive-never-delete) for audit logs, R-class carve-out for replication journals,
set-monotonic ratchet, 8MB streamed threshold. No new decision is introduced at the callsite.

## 1. Over-block (false positive)

- Lint 1 fails a registry entry with no `retention` that is not in the frozen baseline. False positive
  only if a genuinely-new store is legitimately unbounded — which the standard forbids by definition;
  the author declares a policy (incl. `boundedByResolution`). Cannot mis-fire on a legacy store (all
  75 are baselined).
- Lint 2 fails a NEW literal whole-file read of a streamed store. Honest coverage limit: only literal
  paths; dynamic paths are not flagged (no false positives, some false negatives — closed by the
  accessor funnel in Increment 2).

## 2. Under-block (false negative)

Lint 2's dynamic-path gap (e.g. `readFileSync(this.logPath)`) is the known limit — documented in the
lint header and in spec §3c. The runtime growth-burst test is the complete check for stores it
exercises; the accessor funnel (Increment 2) closes the read-side gap. Not silently hidden.

## 4. Signal vs authority

The lints are deterministic STRUCTURAL checks (a path/registry match), permitted to block like the
existing funnel lints (lint-state-registry, lint-no-blocking-process-scans). The SEMANTIC judgment
("is this store actually actionable / which class?") stays with the author + reviewer, never the
regex. Ships ratchet-over-frozen-baseline (warn-then-ratchet per Maturation Path): the current tree
is grandfathered; only NEW violations fail.

## 5. Interactions

The new `maybeRotateJsonlSegment` is additive — no existing caller of `maybeRotateJsonl` is changed,
so no store's rotation behavior changes in Increment 1 (verified: the existing
`tests/unit/jsonl-rotation.test.ts` 11 tests still pass). The registry gains fields read only by the
two new lints. No existing reader of the registry breaks (additive JSON fields).

## 6. External surfaces

None. No new HTTP route, no config-contract change, no messaging, no persistence-schema change. The
two `scripts/*.js` lints run only at lint/CI time.

## 6b. Operator-surface quality

N/A — no operator/dashboard/approval surface is touched.

## Framework generality

N/A — `JsonlStore`/the lints are framework-agnostic infrastructure; not part of the session
launch/inject abstraction. Works identically regardless of the agent's framework.

## 7. Multi-machine posture (Cross-Machine Coherence)

The registry's `retention.access` and the new `coherenceScope` usage declare per-store posture.
Retention is MACHINE-LOCAL by design (each machine's `.instar/` stores differ in size; the rotator
runs per-machine). The replication substrate (`state/coherence-journal/**`) is explicitly R-class
(carved OUT of generic rotation — naive truncation would resurrect deleted PII); it is bounded inside
its own protocol (the seq-floor prune guard is Increment 2). No replicated state is introduced.

## 8. Rollback cost

Trivial. The lints ship over a frozen baseline (no current-tree failures); removing them from
`package.json` reverts the enforcement. `maybeRotateJsonlSegment` + `JsonlStore` are new, unused by
any runtime store yet (Increment 2 wires them), so reverting is a clean delete. The registry fields
are additive data. Nothing to migrate back.

## Evidence pointers

- `tests/unit/jsonl-segment-rotation.test.ts` (7): rename-not-rewrite, prune-beyond-keep, archive
  never-prunes, JsonlStore amortized check + bounded-under-flood.
- `tests/integration/store-growth-burst-invariant.test.ts` (3): A-class on-disk bounded under a
  20k-entry flood; C-class never drops its oldest segment; every registry A-class entry has an
  enforceable maxBytes.
- `tests/unit/bounded-accumulation-lints.test.ts` (7): both lints, both sides of each boundary
  (pass current / fail new-unretentioned / pass new-with-retention / fail grown-baseline; Lint 2
  pass-clean / fail-new-literal-read / pass-grandfathered).
- Existing `tests/unit/jsonl-rotation.test.ts` (11) still green → no regression to the old path.
- `npm run lint` green (the two new lints in the chain).

## Conclusion

A non-behavioral enforcement substrate: the registry declares ceilings, two lints ratchet new
violations, and the event-loop-safe rotation primitive + accessor are ready for Increment 2 to wire
to real stores. Grandfathers the current tree, fails only NEW violations, trivially reversible. Ship.
