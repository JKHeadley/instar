# Side-Effects Review — Local Link And Confirm-Page PIN Composition

Date: 2026-11-23. Author: echo. Tier2 security reconciliation of two approved parent changes; fresh main4888c298e plus3406@77c60a0b2 and3586@e485208cc. Candidate only, held behind both parents and complete verification. Five independent review angles completed, with one test correction and a second read for that correction.

## Summary of the change

The merge preserves the local dashboard link's bounded verified-local allowance and the confirm page's shared synchronous verifier. Two AgentServer conflict blocks are reconciled: keep the refactored admission decision and retain the local recovery hint in its rendering helper; keep both local-access and public-verifier setup blocks. Existing local-link HTTP tests now boot with both features and a real recommended-services ledger, plus three cross-boundary cases. No limits, credentials, public interfaces or migrations are newly introduced by the reconciliation. Parent specs: docs/specs/identity-security-piece1a-local-link.md and docs/specs/sec135-approval-link-guess-bound.md, both already approved and converged. Their agent-awareness entries and installation paths are retained.

## Decision-point inventory

- Dashboard unlock: preserve verified-local admission, bounded failure accounting and no reset on success.
- Public PIN admission: preserve shared local/public/marked classification and rejection responses.
- Confirm-page verification: preserve synchronous admission, per-request cap and charging; local-link credentials are deliberately not authority here.

## 1. Over-block

A valid verified-local dashboard proof must still work after ordinary local guesses are exhausted. Existing HTTP and lifecycle tests cover that recovery. Once its own allowance is exhausted, the existing normal-rule fallback remains. The recovery launcher hint is restored to the refactored response renderer. No new rejection condition is introduced.

## 2. Under-block

A valid local-link proof must not remove a confirm token's request cap. A combined HTTP test sends real proofs with failed confirm attempts and verifies the right PIN still gets429 after the cap. Public cap exhaustion must survive successful local unlock; a second combined case proves that. Existing fake/expired proof, host/origin and same-network rejection checks remain.

## 3. Level-of-abstraction fit

Reconcile the two existing AgentServer authorities at their shared constructor wiring. Neither route gains an independent verifier. Confirmation continues to consume ctx.publicPin; dashboard unlock continues to consume LocalAccessService solely at its approved boundary.

## 4. Signal vs authority compliance

Reference: docs/signal-vs-authority.md. Authentication proofs, request caps and origin restrictions are hard security invariants in an enumerable domain, not conversational-meaning detectors. No brittle judgment authority is added; existing approved authentication policy is preserved.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. No changes to model admission, session lifetime or message judgment.

## 5. Interactions

Shadowing: retain publicPinAdmission before public verification, but permit the existing verified-local dashboard path to use its own budget. Double-fire: verified-local failures charge their dedicated counter, not the ordinary local counter. Races: the confirm verifier remains synchronous with admission and failure charging. Feedback: successful verified-local unlock does not reset any guessing budget; HTTP reads the durable count before and after success.

## 6. External surfaces

The two approved parent surfaces remain the dashboard link and confirm page. No additional messaging, external service calls or operator approvals. Existing state formats remain compatible. The candidate includes both parents and must not merge before their prerequisites and normal verification. Publication is through the Chief of Staff; the unset connector grant is not bypassed.

## 6b. Operator-surface quality

The reconciliation adds no renderer. Existing parent pages and phone-accessible confirmation flow are retained. The local lockout answer retains its plain-language recovery instruction. No new raw identifiers, destructive controls, truncated text or layout changes.

## 7. Multi-machine posture

Machine-local BY DESIGN: local-link proofs bind one machine/listener, and PIN-attempt counters remain at that machine's authentication boundary. No cross-machine portability is implied; no new replication or pool-wide verdict is introduced. Existing alert dispatch and one-voice behavior are unchanged. Topic transfer cannot carry a local credential to another listener. No new status/health/capabilities/channels response. No new generated URLs beyond the parents' listener-bound links.

## 8. Rollback cost

Do not publish the unresolved diagnostic merge tree. Discard the candidate before merge or revert its composition changes after merge; no state migration or credential cleanup introduced by reconciliation. Parent feature flags retain their existing rollback behavior. Reverting must preserve whichever independently approved parent is already live.

## Class-Closure Declaration

No agent-authored-artifact defect or self-triggered controller is being repaired; this is reconciliation of two approved runtime changes. Not applicable.

## Evidence

Combined focused unit65/65; HTTP13/13 (including three new cross-boundary cases); production lifecycle6/6; type check passed. The HTTP suite passed again after the reviewer-requested Origin header correction. A temporary mutation exempting valid local proofs from the confirm request cap made the corrected case fail429-versus200; original source was restored in a finally block. Final restored-source HTTP rerun passed13/13 before commit. Complete suite remains mandatory and unclaimed until shared verifier returns a pass.

## Second-pass review

- pin_security_review: concur; no composition-specific security regression, local-link authority remains confined to dashboard unlock.
- pin_correctness_review: concur; both initializers, consistent admission results and failure/success accounting preserved.
- pin_tests_review: initially raised missing Origin on the confirm proof test; corrected to a matching Origin, reread and concurred. No other blocking coverage gap.
- pin_wiring_review: concur; actual production holders/delegates and off/dark/marker behavior preserved.
- pin_sideeffects_review: concur; hard-invariant exception, machine-local scope, no new migration or renderer, rollback guidance appropriate.

All reviews were read-only and certify neither full verification nor deployment. Existing prerequisites and safety holds remain.
