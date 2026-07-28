# Side-Effects Review — Forensic dedupKey stability (§19.4 follow-on)

**Spec:** `docs/specs/FRAMEWORK-ONBOARDING-MENTOR-SPEC.md` (converged 5 iters, approved by Justin)
**Change:** Hardens Stage-B forensic dedupKey stability so the same root issue produces the same
key across ticks (§13.3: "title is too operator-dependent"). Found by **live validation**: running
the real forensics through 3 iterations on real data logged the same issue 2–3× under different
keys, because the LLM-omitted-key fallback derived from the (drifting) title. Fix: (1) the prompt
now demands a stable, symptom-based lowercase-kebab `dedupKey` with explicit "no versions / numbers /
ids / wording variants" guidance; (2) the fallback derivation strips volatile tokens
(numbers, version/percent/unit literals, hex ids) before slugging.
**Files:** `src/scheduler/MentorStageBForensics.ts`, `tests/unit/MentorStageBForensics.test.ts`,
`upgrades/NEXT.md`.

## Principle check (Phase 1)

Decision point? No. This sharpens an identifier (dedup quality) on a signal-only path. No gating.

## The seven questions

1. **Over-block.** Over-aggressive token stripping could in theory merge two genuinely-distinct
   issues whose titles differ only in numbers. Mitigated: the strip only applies to the *fallback*
   (when the LLM omits a key); the LLM-supplied symptom key is preferred. And §13.3's design makes
   false merges the conservative-acceptable direction only on `dedupKey` while `signature` (the full
   title) preserves the distinction for probable-dup review.
2. **Under-block.** LLM forensics are inherently variable run-to-run, so cross-tick merging is
   improved (live-measured 16→12 issues over the same 3 iterations) but not perfect; the residual
   is handled by the `signature`-based probable-dup review (§13.3), unchanged.
3. **Level-of-abstraction fit.** Pure-module change (prompt + key derivation); no I/O. Correct layer.
4. **Signal vs authority.** Unchanged — signal-only.
5. **Interactions.** Only changes the `dedupKey` a finding carries; the ledger's existing
   conservative auto-merge on `(framework, dedupKey)` does the rest (no ledger change).
6. **External surfaces.** None — internal forensic logic.
7. **Rollback cost.** Trivial — revert the prompt + derivation change.

## Phase 5 — second-pass

Not required — a dedup-quality refinement on a pure, tested module; no decision/spawn/session surface.

## Validation

Live re-run on Echo's real server.log + Codey's real rollouts: before, 3 iterations produced 16
issues (near-zero cross-tick merge); after, the same 3 iterations produced 12 (iterations 2–3 each
merged ~half their findings into existing issues) — the cross-tick merge now demonstrably works.

## Testing

13 unit tests (+3): prefers the model-supplied stable key; fallback strips volatile tokens so
phrasing/number variants of one issue collapse to the same key; version/percent/hex tokens stripped.
Affected push-config suite green vs canonical main.
