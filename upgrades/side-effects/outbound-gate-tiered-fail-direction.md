# Side-effects review — outbound-gate-tiered-fail-direction

Change: the MessagingToneGate's AVAILABILITY-failure fail-direction (capacity-shed / provider-error / unparseable-after-retry / route-budget-timeout — the no-verdict branches) is now TIERED by a structurally-resolved recipient class — operator's own channel DELIVERS (so the operator isn't sealed out), external HOLDS (fail-closed). Default OFF (`failClosedMode:'always'` = today's behavior); `tiered` is an explicit opt-in, dryRun-first. Files: `src/core/MessagingToneGate.ts`, `src/server/outboundGateBudget.ts`, `src/server/toneRecipientClass.ts` (new), `src/server/routes.ts`, `src/commands/server.ts`, tests.

1. **Over-block:** REDUCES a specific over-block — operator-bound status replies held under capacity/timeout pressure (the confirmed 2026-06-25 live lockout). Only on the operator's own verified channel, only on a no-verdict availability failure, only when `tiered` is opted in.

2. **Under-block:** None new. External channels keep today's fail-CLOSED hold verbatim. A real CONTENT/B15 BLOCK verdict ALWAYS holds on every channel (tiering touches ONLY the no-verdict availability branches — `interpret()` verdicts return before the tier). `recipientClass` defaults `external` (fail-closed) on ANY ambiguity.

3. **Level-of-abstraction fit:** Correct. Recipient resolution at the route seam (where the verified-operator binding + topicId live); the gate consumes a resolved `recipientClass` (it never sniffs identity). The budget-timeout seam — a SEPARATE fail-point from the in-gate paths — tiers on the SAME resolved value, so they can't disagree.

4. **Signal vs authority:** The tone gate remains the single authority for outbound behavioral VERDICTS. This tiers only the DEGRADATION policy (what to do when no verdict could be produced) — not a behavioral verdict. recipientClass is resolved STRUCTURALLY from the verified, locally-auth-bound operator (`asVerifiedOperator` — local-auth-only by the store invariant), NEVER from the launderable `recipientType` and NEVER from content (Know Your Principal). This was the convergence BLOCKER: the first draft keyed on `recipientType` (spoofable, defaults primary-user) — fixed.

5. **Interactions:** Reconciles two standards by channel-tiering — No-Silent-Degradation (external still fail-closed) × Operator-Channel-Sacred (operator delivers). The CoherenceReviewer/CoherenceGate half of the same blindspot already shipped (CMT-1794, abstain-tiering) and is untouched. The deliver-on-failure is AUDITED via `failedOpenOperatorChannel` through `logToneGateDecision` (never silent). Capacity-shed delivery for the operator spawns NOTHING (message already composed), so the fork-bomb P3 floor is intact.

6. **External surfaces:** No new routes. A new `ToneReviewResult.failedOpenOperatorChannel` disposition + a `[tone-gate]` decision-log field. Behavior change is gated behind `messaging.toneGate.failClosedMode:'tiered'` (default `always`).

7. **Multi-machine posture:** Machine-local per send. The verified-operator binding is the LOCAL auth-bound record (the replicated topic-operator store is explicitly never authoritative); the gate runs on whichever machine sends. No new cross-machine surface.

8. **Rollback cost:** Low. `failClosedMode` unset / `'always'` = today's behavior (the default — zero change on upgrade). `'never'` restores legacy fail-open. `toneTierDryRun:true` soaks (logs would-deliver, still holds). All live-config (the getter is read per-review). No data migration.

## Build-time wiring preconditions honored (convergence confirmation)
- recipientClass reads the LOCAL auth-bound operator (`asVerifiedOperator`, local-only by store invariant), not the replicated store. ✓
- 1:1-operator-topic signal is concrete: a SINGLE distinct verified operator uid across `topicOperatorStore.all()` (multi-operator agent → external). Defaults external on any error. ✓

## Second-pass review (required — touches an outbound message gate)
The 3-round convergence (adversarial + lessons-aware reviewers + Standards-Conformance Gate + a confirmation pass) IS the second-pass review: it caught a spoofable-leak design (recipientType→structural), a live-default→dark-default posture fix, a confabulated consistency claim, and 4 other majors — ALL resolved in this implementation and pinned by 22 unit tests (gate boundary + route resolution + budget seam). The confirmation pass verified every blocker resolved. Concur with the implemented design.
