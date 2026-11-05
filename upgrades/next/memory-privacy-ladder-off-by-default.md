<!-- bump: patch -->
<!-- internal-only -->

## What Changed

The memory-privacy spec and the maturation board now say what has shipped since 1.3.1657: memory privacy is off by default and on only when an owner turns it on. The board gains a memory-privacy entry whose last rung is "off by owner preference", decided by Justin on 2026-11-04, with a development-agent rung that still has to earn its evidence. No runtime behaviour changes.

## Evidence

`tests/unit/feature-ladders-coverage.test.ts` and `tests/unit/MaturationLadder.test.ts`: 45 passed with the new entry. The maturation-plan gate (`findMaturationPlanGaps` with the ladder required) passes on the edited spec.
