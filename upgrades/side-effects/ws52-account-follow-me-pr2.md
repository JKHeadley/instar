# Side-Effects Review — WS5.2 Account Follow-Me, PR2 (Mechanism B enroll-drive)

**Version / slug:** `ws52-account-follow-me-pr2`
**Date:** `2026-06-17`
**Author:** Echo (autonomous)
**Second-pass reviewer:** REQUIRED (high-risk: credentials, mandate authorization, cross-machine mesh delivery) — to be appended.
**Spec:** `docs/specs/ws52-account-follow-me-security.md` (converged 2026-06-13, approved)
**Status:** READY — the detection→consent flow is built, production-wired, and tested (37 tests: 35 unit across 7 modules + 2 Tier-2 integration over the real HTTP pipeline; tsc clean). PR2 ships the detection/consent/offer surface; the email-gate-at-completion (S7) wiring + the router `locallyExecutable` gate are PR3 (selection-safety) <!-- tracked: CMT-1620 --> (the email-gate LOGIC is already built + unit-tested here; only its completion-flow wiring is PR3). Revocation is PR4 <!-- tracked: CMT-1620 -->.

## Summary of the change

PR2 builds Mechanism B (re-mint per machine) account enrollment — the "one approval per machine, ToS-safe" flow. Per OQ6 (resolved per the spec's lean + the 2-machine topology) the transport is **per-server operator-side selection**, not a new credential-adjacent mesh verb. PR2 ships the decision/orchestration logic (built, unit-tested) + the server-shell wiring (pending).

Files added (all unit-tested, dark behind `multiMachine.accountFollowMe`):
- `src/core/AccountFollowMeOrchestrator.ts` — §5.2 request-never-self-authorize: depth-zero → MandateGate.evaluate(`account-follow-me`) → deny/no-mandate ⇒ phone-first consent (never proceed/CLI); allow ⇒ proceed.
- `src/core/AccountFollowMeEmailGate.ts` — §5.3/S7 email-validation-before-selectable (fail-closed; HIGH attention item on mismatch).
- `src/core/AccountFollowMeDetector.ts` — depth-zero offer detection, R7-bounded (per-account max-follow cap, one-per-(account,target), in-flight dedup).
- `src/coordination/AccountFollowMeMandateBridge.ts` — R4a cross-machine mandate package/accept via PR1's Ed25519 signMandateIssuance/verifyMandateIssuance.
- `src/core/AccountFollowMeService.ts` — composes the above: `scanAndOffer()` (one aggregated consent, enrolls nothing) + `onMandateDelivered()` (verify → allow → enroll-drive instruction).
- `src/core/accountFollowMeDepth.ts` — pure adapter: per-machine pool views → detector input (usable = locallyHeld + active/warming; meta-only ⇒ depth-zero).
- `src/core/fetchPeerSubscriptionViews.ts` — extracts the `?scope=pool` fan-out into a tolerant, injectable peer-views fetcher (dark peers skipped, never throws).
- `src/server/routes.ts` — `POST /subscription-pool/follow-me/scan` (dark→503; enabled→detect depth-zero peers→ONE aggregated consent attention item, enrolls nothing) + an optional `accountFollowMePeerViews` RouteContext field.
- `src/server/AgentServer.ts` + `src/commands/server.ts` — thread + construct the real peer-views fetcher (listPoolMachines + fetchPeerSubscriptionViews, authToken).
- `tests/integration/account-follow-me-scan-route.test.ts` — Tier-2 over the real HTTP pipeline (dark→503; enabled→detect+one-consent).
- 37 tests total (35 unit across 7 modules + 2 Tier-2).

## The eight side-effect questions (for the built decision logic)

1. **Over-block** — The detector only offers to DEPTH-ZERO machines and caps per account; a machine that already serves is never offered, and the cap can suppress a legitimate offer past N machines (intended R7 bound, operator-tunable). No legitimate enrollment is silently lost — it's surfaced as consent or capped-by-policy.
2. **Under-block** — PR2 logic does not itself perform the credential write (the server-shell does, pending); the at-rest residual / revocation (R10/R12) is PR4, tracked. The orchestrator denies by default, so the under-block risk (enrolling without authorization) is structurally closed at the decision layer.
3. **Level-of-abstraction fit** — Decision logic is pure + injectable (no I/O), mirroring PR1's primitives; side effects (attention item, EnrollmentWizard drive, SubscriptionPool.add) are injected so the server-shell owns I/O. Correct layering.
4. **Signal vs authority** — The orchestrator + bridge are AUTHORITIES (they gate a credential enrollment) but are NOT brittle: authorization delegates to the existing PIN-gated MandateGate + the R4a asymmetric signature, and every path FAILS CLOSED. No brittle check holds blocking authority; deny-by-default throughout.
5. **Interactions** — Reuses PR1's CrossMachineMandate (no duplication) + the existing MandateGate (action-agnostic, no change needed) + the existing EnrollmentWizard/enroll routes (no fork). The `account-follow-me` action is a new string in the existing gate — no schema change.
6. **External surfaces** — Dark on fleet. The consent surface is a phone-first dashboard deep-link, never a CLI instruction. The aggregated consent is ONE attention item (P17), never per-machine spam. No credential or token is in any surface the logic produces.
7. **Multi-machine posture** — This IS the multi-machine feature. Mandate authority crosses via the R4a asymmetric signature (verified-operator binding); the credential is re-minted per machine (never replicated). Operator-rooted, not peer-quorum. Single-machine = no-op (no depth-zero peers).
8. **Rollback cost** — Low. Dark behind `multiMachine.accountFollowMe`; revert the PR. No data migration (no live credential written by PR2's logic layer). The server-shell increment carries its own rollback once added.

## Wired-surface notes (questions 2/6/8 for the shipped detection surface)

- **Under-block (2):** the scan route only SURFACES consent (enrolls nothing); the credential write stays in the existing operator-driven enroll route. The email-gate (S7) validating a completed enrollment is PR3 <!-- tracked: CMT-1620 --> — until then a follow-me enrollment relies on the operator approving on the target's own dashboard (the existing, already-shipped enroll flow). No new credential path is opened by PR2.
- **External surfaces (6):** the scan route fetches peers' PLAIN `/subscription-pool` (Bearer `config.authToken`, 4s timeout, dark-peer-tolerant) — same auth + tolerance posture as the existing `?scope=pool` / `/guards` fan-out. It surfaces ONE aggregated attention item (category `account-follow-me`), never per-machine spam. Dark on fleet (resolveDevAgentGate → 503).
- **Rollback (8):** dark behind `multiMachine.accountFollowMe`; revert the PR. No data migration; no credential written by the detection surface. The `accountFollowMePeerViews` ctx field + server wiring are additive/optional.

## Pending for PR3/PR4 (tracked)

- PR3 <!-- tracked: CMT-1620 -->: wire the email-gate at enrollment completion (S7) + the router `locallyExecutable` gate (§6.2).
- PR4 <!-- tracked: CMT-1620 -->: revocation (R12).

## Second-pass review

**Verdict: Concur with the review.** (Independent reviewer subagent, 2026-06-17; ran 35 unit + 2 integration tests green + `tsc --noEmit` clean.)

Verified the four focus areas:
- **(a) No self-authorization path** — `requestEnrollment` short-circuits to consent BEFORE the gate when no mandateId; only returns proceed on an explicit gate `allow`. `scanAndOffer` never passes a mandateId (structurally consent-only). `onMandateDelivered` requires the R4a asymmetric verify AND the real MandateGate (authorship/expiry/revocation/named-party/bounds). Deny-by-default holds.
- **(b) No credential leak** — the peer fetch hits each peer's PLAIN `/subscription-pool` (no scope=pool recursion), projects only id/email/status, discards configHome; SubscriptionAccount structurally cannot carry a token; consent/attention surfaces are metadata-only.
- **(c) Dark-default genuinely inert** — scan route 503s on the fleet via resolveDevAgentGate; integration test asserts it.
- **(d) No fail-open bugs** — meta-only never counts usable; a dark peer can't make a held machine read depth-zero; email-gate + mandate-verify fail closed; the R7 cap is order-independent.

Two non-blocking notes for the PR3+ author (NOT PR2 defects — PR2 never reaches these): the route wires `agentFp` to `ctx.config.projectName ?? 'self'`, which must match the named agent party once the real mandate-delivered flow lands in PR3; and the plain `/subscription-pool` route serializes `configHome` (a path, never a token; pre-existing, Bearer-gated) which the PR2 fetcher correctly discards.
