# Convergence Report — OwnershipApplier mesh-self ordering fix

## Cross-model review: codex-cli:gpt-5.5 + gemini-cli:gemini-2.5-pro (RAN, both families)

Both supported non-Claude families were available and ran each round (codex gpt-5.5,
gemini gemini-2.5-pro). The spec received genuine cross-model review across all rounds.

## ELI10 Overview

Moving a conversation between my machines was reported as succeeding while the destination
machine never actually took ownership — so the conversation went silent on arrival. The
cause: the code that hands ownership to the destination was never switched on, because its
on-switch read a "which machine am I?" value that the startup sequence doesn't fill in until
650 lines later. The fix makes that value late-bound and switches the component on based on
the genuinely relevant condition (the durable store being active), pulled into a tiny
testable function. The live two-machine re-run is the release gate.

## Origin

Found by APPLYING the Live-User-Channel Proof gold standard to the multi-machine transfer —
the second, deeper bug the standard caught (the first, dev-gate-darkness, shipped in #1190 /
v1.3.590). Activation alone was necessary but not sufficient: the durable store activates but
the component that consumes it never ran.

## Iteration Summary

| Iteration | Reviewers | Material findings | Spec changes |
|-----------|-----------|-------------------|--------------|
| 1 | conformance (2 possible-violations), codex (MINOR/2pts) | Testing scope; Bug-Fix Evidence Bar; helper-not-server test surface; SELF-label over-requirement | Added Verification (reproduce-then-verify) section; relaxed SELF-label gate; committed integration tier |
| 2 | conformance (1: Observability), codex (MINOR) | Observability surface; logs-as-correctness brittleness | Added Observability section; extracted testable `wireOwnershipApplier` factory; made durable state (not logs) the authoritative gate |
| 3 | conformance (clean), codex (MINOR), gemini (CLEAN) | Residual: factory unit test ≠ proof server.ts invokes it under boot order | Named the residual explicitly + assigned it to the Tier-3 live-E2E release gate |
| — | (converged) | 0 material-new | — |

## Standards-Conformance Gate

Ran every round (22 standards). Round 1: 2 possible-violations (Testing Integrity, Bug-Fix
Evidence Bar). Round 2: 1 (Observability). Round 3: **0 possible-violations**.

## Convergence verdict

Converged. Gemini CLEAN; codex descended to a single MINOR residual that is structurally
answered by the spec's existing Tier-3 live-verification release gate (a unit test cannot
prove server.ts boot-invocation; the live E2E asserts the server's own applier ran). Zero
open questions. The fix is surgical (lazy-bind `selfMachineId` + a testable
`wireOwnershipApplier` factory gated on the durable store alone) and order-independent —
robust against future reordering, which is what made the original bug possible. Ready for
approval.
