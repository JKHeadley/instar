# Convergence report — Secret Drop Sliding Window + Atomic Use-and-Consume

**Spec:** `docs/specs/secret-drop-sliding-window.md`
**Round:** 1 (3 independent reviewers: design, safety, completeness)
**Date:** 2026-06-02

## Reviewer verdicts

| Lens | Verdict | Summary |
|------|---------|---------|
| Safety/Security | **converge** | No disk/argv/stdout/log leak; value piped to subprocess stdin only. Sliding window cannot exceed the 30-min cap (`Math.min` clamps `fireIn`), so an attacker with the token cannot keep a secret alive indefinitely. One-time submission, CSRF, R1a sender-verification all untouched. |
| Design | needs-changes → resolved | Logic correct; asked for justification of the timing constants, a Structure>Willpower honesty note (peek vs consume), and accurate testing language. |
| Completeness | needs-changes → resolved | Migration parity confirmed (helper always-overwrite; awareness in scaffold + new migrator block). **Material:** the new `--run` CLAUDE.md migration block had no test. |

## Resolutions

1. **(Completeness, material) Untested `--run` migration block** → Added two tests to
   `PostUpdateMigrator-secretDropHardenedRetrieve.test.ts`: inserts the `--run` bullet
   when the hardened helper is already documented, and is idempotent on re-run. 15/15
   green.
2. **(Design) Timing constants unjustified** → Added a "Timing rationale" subsection
   (15 min = matches link TTL + covers real handoffs; 30 min cap = tight bound on
   in-memory lifetime).
3. **(Design) Structure>Willpower overclaim** → Added an honest-limit note: the
   sliding window relies on the consumer using `peek`; `--run` is the structural fix
   for consume-on-failure; the cap is the backstop.
4. **(Design/Completeness) Testing language** → Rewrote the Testing section: corrected
   "shell"→Node, listed the real boundary coverage, declared the single acceptable gap
   (the `--run` spawnSync wrapper is `node --check` + arg-parse verified, not unit
   tested) explicitly rather than overstating it.
5. **(Design) Server-restart scenario** → Expanded the non-goal to state the explicit
   contract (durable across activity + time up to the cap, NOT across a restart) and
   linked the encrypted-at-rest follow-up to its tracker.

## Outcome

All material findings resolved in-spec or in-code. Safety lens clean from the start.
Converged.
