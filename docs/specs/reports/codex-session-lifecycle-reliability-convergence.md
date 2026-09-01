# Convergence Report — Codex session lifecycle reliability

## Cross-model review: codex-cli:gpt-5.5

The external Codex reviewer ran on every changed review body. Its final pass returned `MINOR ISSUES`; recurring complexity/readability concerns were recorded as precision and known validation risks, while no final delta-level safety defect remained.

## ELI10 Overview

The incidents that look like “Codex stalled” are several different states: a protected Codex helper, a real user command, text still in the composer, a message consumed by Codex, a normally completed turn, or a dead session. The design gives each state its own evidence and owner instead of treating a successful key send as recovery.

The live repair has three layers: prevent the watchdog from killing proven Codex infrastructure; journal and verify every inbound/key effect across crashes; and keep optional scoped refresh/replay behind deterministic fences, Tier-1 veto supervision, and a separate maturation gate. Multi-machine transfer preserves live delivery state and exactly-one ownership.

## Original vs Converged

The original proposal protected `codex-code-mode-host` and added a delivery marker. Review expanded only where material failure evidence required it: descendant-process inspection, orthogonal composer/transcript states, durable dispatch and key-attempt journals, no-blind-resend reconciliation, single physical-effect locking, FIFO sequencing, scoped refresh rather than server restart, authenticated transfer, source-loss fencing, bounded storage, and explicit fleet rollout gates.

The final user-authorized delta closed the last half-commit window: normal tracked sends now persist `prepared → dispatch-armed → dispatch-started → dispatched|failed|effect-unknown`, and keypress rungs use the same discipline. Cross-platform lock providers and restart-time activation make that invariant fleet-safe.

## Iteration Summary

- Rounds 1–8 surfaced and closed architectural findings across security, scalability, adversarial, integration, decision-completeness, and lessons/foundation perspectives.
- Round 9 closed recovery journal half-commits and ownership/effect fencing.
- Round 10 found one remaining normal-dispatch half-commit window.
- The operator authorized an additional convergence pass with the 80/20 rule applied fractally.
- Delta pass 1 closed normal dispatch but found two direct leaves: key-attempt crash accounting and Windows physical locking.
- Delta pass 2: all three internal lenses reported `DESIGN count: 0`; constitutional gate checked 90/90 standards with zero findings.
- Standards-Conformance Gate ran every changed round; final result: 90 checked, 0 flags, not degraded.
- External review ran through `codex-cli:gpt-5.5`; final result: minor precision/complexity notes only.

## Fractal 80/20 Disposition

Each subsystem converged when its load-bearing core had one authority, explicit evidence/state, bounded work/storage, crash/partition behavior, and decision-boundary tests. A design finding reopened only that subsystem and direct dependents. Precision/readability findings remained documented but did not recursively reopen clean transfer, crypto, rollout, or continuation branches.

## Final Design Assurance

- Security/integration: clean.
- Scalability/decision completeness: clean; no hidden user decision.
- Adversarial/lessons/foundation: clean after tracked-send delta.
- Cross-platform delta: clean for macOS/Linux `flock` and Windows `LockFileEx` provider contract.
- Open questions: none. Residual operational risks are explicitly listed in the spec with fail-closed/fail-toward-delivery handling.

## Approval

Justin approved the autonomous workstream and explicitly authorized convergence beyond the ten-round cap on 2026-08-28, conditional on fractal 80/20 convergence. The final two delta checks applied that condition and returned zero DESIGN findings.
