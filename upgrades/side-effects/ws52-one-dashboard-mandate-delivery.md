# Side-Effects Review — WS5.2 one-dashboard cross-machine mandate delivery

**Version / slug:** `ws52-one-dashboard-mandate-delivery`
**Date:** `2026-06-17`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `concurred (HIGH-stakes: cross-machine authorization delivery)`

## Summary of the change

Operator feedback (topic 13481): "there should only be ONE dashboard for the agent, not one per machine." Today an account-follow-me enrollment on a TARGET machine needs a PIN-gated mandate ISSUED on that target's OWN dashboard — the per-machine friction the operator rejects. This change lets the operator's SINGLE dashboard issue + deliver the mandate to the target, verified there via the already-approved ws52 R4a bridge. New `POST /mandate/issue-for-machine` (PIN-gated, same auth as `/mandate/issue`): issues the mandate locally, then for a REMOTE target packages it (`packageMandateForDelivery`, signed with this operator machine's Ed25519 identity key) and dispatches it over a new `account-follow-me-mandate-deliver` mesh verb. The target's handler authenticates the mesh `sender` (existing Ed25519 envelope verification → the registered operator-machine identity), resolves that sender's REGISTERED key, R4a-verifies the mandate's issuance signature against it (`acceptMandateDelivery` → `acceptDeliveredMandate`, with `expectedIssuer === authenticated sender`), checks exact bounds (account-follow-me / this machine / re-mint), and only then persists it to a new `DeliveredMandateStore`. The enroll-start route (`POST /subscription-pool/follow-me/enroll/start`) now, when the LOCAL gate denies, ALSO consults the delivered mandate — re-verifying the R4a signature at point-of-use and re-checking bounds — both paths fail-closed (403). Files: `AccountFollowMeMandateDelivery.ts` + `DeliveredMandateStore.ts` (new), `MeshRpc.ts`, `routes.ts`, `AgentServer.ts`, `commands/server.ts`, `dashboard/mandates.js`. Dark behind `multiMachine.accountFollowMe`.

## Decision-point inventory

- `account-follow-me-mandate-deliver` mesh verb handler / `acceptMandateDelivery` — **add** — the cross-machine authorization-acceptance decision: a delivered mandate is trusted ONLY via R4a verification against the authenticated sender's registered key + exact bounds. Deny-by-default.
- `POST /mandate/issue-for-machine` — **add** — PIN-gated issuance + remote delivery (agent cannot self-issue).
- enroll-start delivered-mandate consultation — **modify** — an ADDITIONAL fail-closed authorization source alongside the unchanged local gate.

---

## 1. Over-block
Conservative by design: any uncertainty (no registered operator key for the sender, signature fails, bounds mismatch, target≠this machine, feature off) denies. The operator's own PIN-gated issuance is unchanged, so the operator is never wrongly blocked from authorizing; a delivery that can't be verified simply isn't honored (the operator retries / the honest 502 surfaces). No legitimate authorized enrollment is rejected.

## 2. Under-block
The delivered mandate authorizes ONLY its exact bounds (account-follow-me, specific accountId, this targetMachineId, re-mint). It cannot be replayed for another account/machine. It does not expand what a mandate authorizes — it only changes WHERE the operator can issue it from (one dashboard) and HOW it reaches the target (signed mesh delivery). The downstream S7 email-gate + the enrollment flow are unchanged.

## 3. Level-of-abstraction fit
Correct: issuance stays in the PIN-gated mandate route; delivery rides the existing authenticated `meshRpcDispatcher` (same pipe as remote-close); acceptance uses the already-approved ws52 R4a bridge (`acceptDeliveredMandate`); the core `MandateGate` authorship model is UNTOUCHED (delivered mandates use the R4a path, scoped to the account-follow-me enroll-start consumer — not a change to how every mandate is trusted). This is the minimal-blast-radius placement.

## 4. Signal vs authority compliance
The authority is the operator's PIN-gated mandate (unchanged) + the R4a cryptographic binding to the registered operator machine. The agent cannot self-issue (bearer token insufficient — PIN required). The mesh verb's real gate is the signature re-verification, not a coarse role check. Deterministic + fail-closed; reference `docs/signal-vs-authority.md`.

## 5. Interactions
The enroll-start consultation is ADDITIVE — the existing local-mandate path is byte-unchanged; the delivered path is reached only when the local gate denies, and both deny-by-default. `verifyDeliveredMandate` re-verifies at point-of-use (never trusts a stored flag). No change to the core MandateGate, so no other mandate consumer is affected. The delivery RPC failure surfaces as an honest 502 (retryable), never a silent stuck issuance.

## 6. External surfaces
One new PIN-gated route + one new mesh verb (deny-by-default, signature-gated) + a dashboard change routing account-follow-me issuance through the new route. All dark behind `multiMachine.accountFollowMe` (503/refuse when off). The mesh verb is only honored from an authenticated registered peer whose R4a signature verifies — no new attack surface for an unauthenticated party.

## 7. Multi-machine posture (Cross-Machine Coherence)
This change EXISTS to fix a cross-machine coherence defect: the per-machine dashboard/mandate seam. It is replicated-by-delivery: the operator's single machine is the issuance authority; the signed mandate is delivered to + verified on the target; the target holds it locally (in DeliveredMandateStore) for its own enroll-start. Trust is grounded in the registered MachineIdentity store (Know Your Principal — the authenticated mesh sender, never a payload name). Single-machine agents never deliver (local target path unchanged) — no-op.

## 8. Rollback cost
Low. Dark by default; new files + additive route/verb; the core MandateGate is untouched so reverting cannot destabilize existing mandate behavior. Single-commit back-out; no migration (DeliveredMandateStore is new + only populated when the feature is live).

---

## 6b. Operator-Surface Quality (dashboard change)

The change touches `dashboard/mandates.js` (an operator surface), so per the Operator-Surface Quality standard:

1. **Right action surfaced prominently / clear next step:** The change makes the EXISTING mandate issue form work for a remote target — when the operator approves an `account-follow-me` authority, it routes through `/mandate/issue-for-machine` and shows a plain-language outcome ("delivered to <machine>" / "issued locally" / a retryable "couldn't reach <machine>" on a 502). The operator's action (approve with PIN) is unchanged and primary; the delivery is automatic. This REMOVES a confusing dead-end (the old "open that machine's dashboard to approve" note) — the exact operator-surface defect this change fixes.
2. **No internals as primary content:** The operator sees machine NICKNAMES and a plain outcome sentence, not fingerprints/mesh internals (those remain in the support/reference line only). The cross-machine delivery + R4a verification happen invisibly.
3. **Destructive actions de-emphasized:** This surface issues an authorization (not a destructive action); revoke remains the separate, clearly-labeled control. Nothing destructive is added or made prominent.
4. **Plain language at phone width:** The new notices are short plain sentences ("Approved — delivered to Mac Mini"), not JSON or jargon, and reuse the existing mobile-responsive mandate-card layout. No new wide/desktop-only element.

(Note: a dedicated pre-filled follow-me picker reading the deep-link `?account=&target=&mechanism=` params is a nice-to-have not built here; the functional path works via the existing form. Tracked as a polish follow-up <!-- tracked: topic-13481 -->.)

## Agent Proposes, Operator Approves

The operator approves a SERVER-AUTHORED request built from STRUCTURED DATA — never agent-supplied free-text:
- The mandate's authority is a structured `CoordinationMandate` (bounds: `accountId`, `targetMachineId`, `mechanism:'re-mint'`, `action:'account-follow-me'`, `expiresAt`) constructed server-side by `MandateStore.issue()` from typed fields. The operator approves it with their dashboard PIN (`checkMandatePin`) — the agent's bearer token cannot issue/widen it (requester ≠ authorizer preserved).
- The cross-machine delivery carries that SAME canonical structured mandate; the R4a signature is over the server-canonicalized bytes (`canonicalMandate`), and the target re-derives the bounds from the structured mandate (`readFollowMeBounds`) — it never parses or trusts agent/operator free-text. A name in the payload is never authority (Know Your Principal); only the structured bounds + the R4a signature against the registered operator key are.
- The dashboard surfaces the structured authority (account + target machine nickname + the fixed action slug) for approval; it does not let the agent inject free-text that becomes the approved authority. The operator approves a typed, server-authored grant, full stop.

## Second-pass review

**Concur with the review.** Independent audit verified all 8 points against the actual source (tsc EXIT=0; 47/47 tests):
1. **Trust anchor = authenticated sender, never payload** — handler resolves `operatorPem = meshIdMgr.getSigningPublicKeyPem(sender)` (same registered-identity source `verifyEnvelope` uses); `acceptMandateDelivery` passes `expectedOperatorMachineFingerprint: sender`; `CrossMachineMandate` rejects `issuerFingerprint !== expectedIssuer`. No payload field is ever the anchor.
2. **R4a load-bearing + fail-closed** — no operator key → refuse; sig fail → refuse; issuer≠sender → refuse; `store.put` strictly after all checks. Unverified mandate never persisted/honored.
3. **Exact-bounds, no replay** — double-gated (accept-time + enroll-start point-of-use): accountId + targetMachineId===this-machine + mechanism=re-mint. A/X cannot be replayed for B/Y.
4. **enroll-start additive + fail-closed** — local path unchanged; delivered path reached only on local-deny; `verifyDeliveredMandate` re-verifies R4a (not a stored flag); no match → 403.
5. **issue-for-machine PIN-gated** — `checkMandatePin` same as `/mandate/issue`; bearer alone insufficient; local-target unchanged.
6. **Mesh RBAC deny-by-default** — own case; `authorizeMandateDeliver ?? false`; real authority = signature re-verify (rogue registered peer still can't deliver an unsigned mandate).
7. **Dark by default** — route 503, verb refused, accept `feature-disabled` when off; single-machine no-op.
8. **No fail-open** — terminal `accepted:true` only after all refusals; the only `@silent-fallback-ok` catches fail toward denial (`ok:false` / `[]`).
