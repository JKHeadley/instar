# Framework stall-coverage matrix — PR-A (registry, validator, CI ratchet, seed matrices)

## What Changed

Instar now carries a canonical registry of every known way a framework session can stop (`src/data/stall-classes.ts`: eight classes, from mid-turn interrupts to context-window walls), and every supported framework must answer for each class in a stall-coverage matrix at `docs/frameworks/<framework>-stall-coverage.md`. A new validator (`src/core/stallCoverageValidator.ts`) enforces the standard structurally: exact status tokens (`covered | covered-dark | declared-gap | not-applicable`), resolvable detector/recovery symbols, positive-control evidence containing the framework's raw stall signature in a test the push suite actually collects, tracked refs on every declared gap, and a calendar aging ratchet on auto-seeded debt. A CI ratchet test in the whole-tree push suite validates all four seed matrices on every push, and an offline-first codemod (`scripts/stall-class-codemod.mjs`) seeds `declared-gap (new-class, unreviewed)` rows into every matrix whenever a class is added — so matrices cannot rot between onboardings.

The four seed matrices ship honest: claude-code writes its existing stall family down for the first time (six classes covered or covered-dark, one declared gap — the drive-5 defect #9 interrupted-resume class, one structural N/A); codex-cli is honest zeros (every class a declared gap, each filed to the framework-issues ledger with a commitment anchor); gemini-cli is all not-applicable (framework dead upstream, `revalidateOn: framework-revival`); pi-cli is honest declared gaps for a ships-dark framework.

This is PR-A of a two-PR staged landing. The runtime apprenticeship gate, acceptance machinery, and the recurring `stall-matrix-live-check` job are PR-B — nothing in PR-A gates any runtime behavior.

## Evidence

- The CI ratchet (`tests/unit/stall-coverage-ratchet.test.ts`) validates all four seed matrices, REQUIRED_MATRIX_FRAMEWORKS file presence, and spec-table/registry agreement — green on this tree.
- Validator boundary tests (`tests/unit/stall-coverage-validator.test.ts`) cover both sides of every hermetic decision boundary from the spec's §5 list.
- Evidence tests (`tests/unit/stall-evidence-claude-code.test.ts`) prove each claude-code covered-row detector genuinely fires on a realistic raw stall signature.
- Codemod fleet-regression tests (`tests/unit/stall-class-codemod.test.ts`) prove: class-addition-without-codemod reds stale matrices; the codemod seeds correctly, idempotently, and honors --dry-run.
- Spec: `docs/specs/framework-stall-coverage-matrix.md` (5 review rounds to convergence incl. cross-model review; operator-approved 2026-07-18).

## What to Tell Your User

No user-visible behavior changes in this release. This is infrastructure honesty: your agent's platform now keeps a complete, continuously-validated map of how sessions can get stuck for every supported framework, so stall detection and recovery stop being learned one silent production stall at a time.

## Summary of New Capabilities

- Canonical stall-class registry + per-framework stall-coverage matrices, CI-validated on every push.
- Class-registry codemod that keeps every matrix complete as the class list grows.
- Honest coverage baselines for claude-code, codex-cli, gemini-cli, and pi-cli (the claude-code stall family is now written down; every other framework's debt is tracked, not invisible).
