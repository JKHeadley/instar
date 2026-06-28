# Side-Effects Review — Mesh Self-Heal SPEC (spec-only, no runtime surface)

**Version / slug:** `mesh-self-heal-spec`
**Date:** `2026-06-27`
**Author:** `echo`
**Second-pass reviewer:** `not required (spec-only doc; the spec itself passed a 5-round /spec-converge with 6 reviewers)`

## Summary of the change

Adds the converged spec `docs/specs/MESH-SELF-HEAL-SPEC.md` (+ its ELI16 companion, the 5-iteration convergence report, and the round-1/2/3 findings catalogs). This commit ships ONLY documentation — no `src/` runtime code. The spec designs the mesh self-heal feature family (G1 lease↔job binding, G2 nobody-polling detector, G3 lease-gated spawn, P2 Machine-Independence Standard) for a LATER `/instar-dev` build in rollout order G3→G2→G1, each gated on live-verification.

## Decision-point inventory

- No runtime decision points are added by THIS commit. The spec DESCRIBES decision points (the lease/poll/spawn gates) that future build PRs will implement behind dark flags; this commit introduces zero executable behavior.

## 1–8 (the review questions)

1. **Over-block:** No block/allow surface — this commit is markdown. Not applicable.
2. **Under-block:** No block/allow surface. Not applicable.
3. **Level-of-abstraction fit:** N/A — documentation. (The spec's OWN design was reviewed across 5 convergence rounds for exactly this; foundation notes §1.3 place each mechanism at the right layer.)
4. **Signal vs authority:** N/A for the doc. (The spec's design holds no brittle blocking authority — the lessons-aware reviewer confirmed across rounds; gates are deterministic safety/recoverability on the primary channel, fail in the safe direction per §8.)
5. **Interactions:** A markdown doc under `docs/specs/` interacts with nothing at runtime. The future build will; this commit does not.
6. **External surfaces:** None. No operator-facing action, no API, no state. The spec is not executable.
6b. **Operator-surface quality:** No operator surface — not applicable.
7. **Multi-machine posture:** N/A for the doc (a spec file replicates with the repo via normal git). The DESIGN's per-feature posture is the §7 table in the spec itself.
8. **Rollback cost:** Pure doc addition — revert the commit. No state, no migration, no user-visible effect (nothing runs).

## Conclusion

Spec-only documentation commit with no runtime surface. The substantive review was the 5-round /spec-converge (30→13→6→1→0 material findings) recorded in the convergence report. Clear to commit. The executable behavior it describes is a SEPARATE future `/instar-dev` build, each piece behind a dark flag and gated on live-verification (§5/§6/§9) — and that build requires the operator's `approved: true` on this spec first (the convergence tag is present; approval is the operator's step).

## Evidence pointers

- `docs/specs/MESH-SELF-HEAL-SPEC.md` (converged, `review-convergence` tagged, 5 iterations)
- `docs/specs/reports/MESH-SELF-HEAL-SPEC-convergence.md` (the report)
- `docs/specs/MESH-SELF-HEAL-SPEC.findings-round{1,2,3}.md` (full findings catalogs)
- Conformance gate: ran each round, 0 at-risk. Cross-model: unavailable (codex-not-installed), recorded honestly.
