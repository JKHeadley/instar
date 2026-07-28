# Convergence Report — Outbound gate tiered fail-direction (MessagingToneGate)

## Cross-model review: SKIPPED-ABBREVIATED (single-framework, load-aware)

External cross-model passes skipped (active load investigation; tightly-scoped single-gate change). The mandatory lessons-aware reviewer ran PLUS an adversarial reviewer + the code-backed Standards-Conformance Gate, and a confirmation round verified the revision — this abbreviated round caught a spoofable-leak design, so it was not a rubber-stamp.

## Iteration Summary

**Round 1 (initial)**
- **Standards-Conformance Gate: ran (1 flag).** "No Silent Degradation to Brittle Fallback" — operator-channel deliver-on-availability-failure looks like silent degradation. → ADDRESSED with a 4-point reconciliation (provider-swap-first, audited/not-silent, channel-scoped, constitutional reconciliation of Operator-Channel-Sacred × No-Silent-Degradation). Lessons-aware reviewer confirmed the reconciliation SOUND.
- **Adversarial reviewer:** 3 BLOCKERS + 4 MAJORS/MINORS. The decisive find: the draft keyed the deliver decision on `recipientType` — the carrier the codebase ALREADY labeled "launderable" (`CoherenceGate.ts:749-756`) and which defaults to `'primary-user'`, so every unbound topic would default to operator→DELIVER (a spoofable leak), shipped live-by-default.
- **Lessons-aware reviewer:** the central "mirrors the coherence side / same carrier" claim was a confabulation — CoherenceGate keys its fail-direction on `isExternal` (channel-based), not `recipientType`; the tone-gate reply path needs the operator-binding because platform-`channel` is uninformative. Plus: Know-Your-Principal resolution lives in new untested route glue (needs a route-level test).

**Round 2 (spec revision)** — every finding addressed: structural resolution from the verified topic-operator binding with an EXPLICIT fail-closed default; 1:1-operator-topic check (multi-user/peer/unbound → external); ONE recipientClass to both fail-seams; tier only the no-verdict branches (real BLOCK always holds); default `always` + dev-gated dryRun-first `tiered` opt-in (not live-default); audit flag wired through metrics; the confabulation corrected to "why the carrier differs"; route-level CI ratchet added.

**Round 3 (confirmation)** — the adversarial reviewer re-verified the revised spec: **B1-B3, M4-M7, and the confabulation ALL RESOLVED.** Two NEW MINOR build-time wiring preconditions surfaced (use `getOperator` reading the LOCAL auth-bound record not the replicated store; define the 1:1-operator-topic signal source concretely, default-false) — neither reopens a blocker; both steered safe by the fail-closed default; folded into the spec's "Build-time wiring preconditions." **Converged.**

## Material findings & resolutions
| Sev | Finding | Resolution |
|-----|---------|------------|
| BLOCKER | keyed on launderable `recipientType` | structural resolution from verified topic-operator binding |
| BLOCKER | default inverts to operator/deliver on ambiguity | explicit default-false → external |
| BLOCKER | platform-`channel` shared by multi-user/peer | 1:1-operator-topic check → those are external |
| MAJOR | route-budget-timeout seam un-tiered | one recipientClass to both seams |
| MAJOR | could suppress real content blocks | tier only no-verdict branches |
| MAJOR | ships live-by-default | default `always`, dev-gated dryRun-first opt-in |
| MAJOR | false "mirror coherence side" | corrected to "why the carrier differs" |
| MINOR | audit tag must be surfaced | wired through logToneGateDecision + /metrics/features |
| MINOR (r3) | `asVerifiedOperator` not a real API | use `getOperator`, local auth-bound only |
| MINOR (r3) | 1:1-topic signal undefined | name source at build, default-false |

## Decision-completeness
All decisions frontloaded; `## Open questions` empty. Ships dark (default `always`), dev-gated dryRun-first.
