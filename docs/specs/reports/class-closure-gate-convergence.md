# Class-Closure Gate + Standards-Delta Escalator — Convergence Record

**Spec:** `docs/specs/class-closure-gate.md` (slug `class-closure-gate`)
**Companion:** `docs/specs/class-closure-gate.eli16.md`
**Status:** CONVERGED — `tags: ["review-convergence"]`, round-5 clean.
**Source program record:** `docs/specs/reports/defect-class-program-round3-2026-07-02.md`
(this spec is one of the five specs of the defect-class standards program; the
program-wide record documents all five, this report distils the class-closure-gate
arm).

## Process

`/spec-converge` iterative review — six internal reviewers (security, scalability,
adversarial, integration, decision-completeness, lessons-aware) plus real
cross-model external reviewers routed through the agent's installed CLIs
(codex → GPT-5.5 via `codex exec --sandbox read-only`; gemini CLI → Gemini-tier),
one pass per available family, iterated to convergence. Grounding checks ran against
canonical `main`: `src/data/llmBenchCoverage.ts`, `.github/workflows/decision-audit-gate.yml`,
`upgrades/side-effects/`, and `docs/STANDARDS-REGISTRY.md` were all verified present;
`src/core/promptClauses.ts` was correctly proposed-new.

## Rounds

- **Round 1** — full panel → ~20 material issues across the program, fixed
  (commit `5eebc12cc`). For class-closure-gate specifically: the round-1 findings
  F9 (record host), F10 (trigger location / deterministic trigger), and the
  dedup-cannot-become-a-suppressor seam were resolved into the current design
  (decision-audit structured block as the machine-readable host; a mirrored,
  display-only side-effects section; a deterministic recurrence trigger that lives
  in the gate lint, not the fleet-dark failure-learning loop).
- **Round 2** — same panel re-review → 9 material seams program-wide, fixed
  (commit `c4fec19b0`). For class-closure-gate: severity made non-optional (every
  class carries `severity`; critical escalates at 1); the derived-count bookkeeping
  cluster resolved (per-PR count edits would merge-conflict between concurrent fixes
  and drag routine fixes through a protected file — counts are now DERIVED from the
  committed declarations, never hand-maintained).
- **Round 3** — targeted clean-pass check → 2 genuinely-new material findings on this
  spec (both fixed in the round-3 edit commit):
  - **C1 (fixed):** `instanceCount` derived by scanning BOTH mirrored hosts with no
    dedup key would double-count every fix (2 real instances reading as 4, falsely
    crossing the ≥3 threshold; duplication also inflates evidence). **Closure:** the
    count derives from decision-audit entries ONLY, deduped by PR number; the
    side-effects mirror is display-only; the lint asserts mirror CONSISTENCY, never
    sums the two hosts.
  - **C3 (fixed):** the ≥N-across-≥2-components trigger never fires for a class
    recurring heavily inside ONE component at normal severity — no arm covered it.
    **Closure:** a single-component arm — ≥K (default 5) within one component
    escalates; the higher K preserves the systemic-vs-noisy-component distinction the
    spread requirement encodes. Decision-point 2 was updated to match.
  - C2 (not-material): classification-accuracy spot-checking re-litigates Frontloaded
    Decision #3 — dryRun measures declaration reliability before the enforcing flip,
    and novel-class gaming is separately closed (unconfirmed classes can't satisfy
    `closure: guard`).
- **Round 4** — targeted verification of the round-3 closures → 1 residual one-line
  inconsistency on this spec (a codex catch, citation-verified): the severity
  paragraph mapped `normal ⇒ the ≥3/≥2 rule`, omitting the K=5 single-component arm —
  the only severity tier where that arm is operative; read as authoritative it would
  have nullified the round-3 closure. Fixed.
- **Round 5** — final clean pass → CONVERGED. The severity paragraph now carries both
  arms with the "only operative for `normal`" rationale. Round-5 verification: codex
  VERIFIED CLEAN; internal three-passage consistency sweep (trigger ¶ / severity ¶ /
  decision-point 2) clean.

## Final state

`review-convergence` tag applied. All open questions were resolved into the spec's
**Frontloaded Decisions** section (initial scope boundary; N/K and windowlessness;
who classifies; record shape; the enforcing-flip criterion with its
cannot-become-a-delay-forever-lever guard; the X1/X2 program-shared machinery).

## Build boundary (per the spec's Run boundary)

The `/instar-dev` build ships: the live gate lint (**report-only**), the class
registry (`docs/defect-classes.json`, seeded with the four measured classes), and the
standards-delta escalator machinery **dark** (deterministic trigger + pattern→proposal
DRAFTER). Registering any standard or touching the constitution is OUT OF SCOPE — it
requires the operator's explicit sign-off (Agent Proposes, Operator Approves). The
operator (Justin) approved the defect-class standards program on 2026-07-03 in topic
29723; that approval is transcribed into the spec's `approved: true` gate marker for
this build (dark/report-only; operator retains veto).
