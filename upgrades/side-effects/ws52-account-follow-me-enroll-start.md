# Side-Effects Review — WS5.2 Account Follow-Me enroll-drive START route

**Version / slug:** `ws52-account-follow-me-enroll-start`
**Date:** `2026-06-17`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `pending (high-risk: mandate authorization + credential enrollment + the live-proof keystone)`

## Summary of the change

WS5.2 R6/R6a(option 2)/S7. The keystone that makes the cross-machine enrollment actually run: a new dark route `POST /subscription-pool/follow-me/enroll/start` (per-server — the operator drives the TARGET machine's own enroll route). Given an operator-issued `account-follow-me` mandate, it (1) verifies the mandate via `ctx.coordination.gate.evaluate({action:'account-follow-me', params:{accountId, targetMachineId, mechanism:'re-mint'}, agentFp, mandateId})` — deny-by-default, non-allow → 403; (2) resolves the operator-APPROVED account email AUTHORITATIVELY (local SubscriptionPool then the replicated `subscription-account-meta` peer views — NEVER the request body, per S7) via the new pure helper `resolveFollowMeEnrollTarget`, unresolvable → 409 fail-closed; (3) allocates a per-account configHome slot on this machine; (4) calls `EnrollmentWizard.start({..., expectedEmail})` returning the device-code/URL. The EXISTING `/complete` route then finishes via `completeFollowMe` (validates the minted login's email == expectedEmail before adding). Files: `src/server/routes.ts` (route + a `resolveAgentFingerprint` helper), `src/core/resolveFollowMeEnrollTarget.ts` (new pure helper), + 2 test files. Dark behind `multiMachine.accountFollowMe`.

## Decision-point inventory

- `POST /subscription-pool/follow-me/enroll/start` mandate check — **add** — the authorization decision: a follow-me enrollment STARTS only under a valid operator `account-follow-me` mandate for this exact (account, this machine, mechanism). Deny-by-default.
- `resolveFollowMeEnrollTarget` — **add** — the S7 decision input: `expectedEmail` is the authoritatively-resolved approved email, never self-asserted; unresolvable → refuse.

---

## 1. Over-block

A legitimate enrollment whose account email is not yet known on this machine (the replicated `subscription-account-meta` hasn't arrived, or the peer holding it is offline) is refused with 409. This is deliberate fail-closed (S7: never start an enrollment without the approved email to validate against). The operator retries once the account metadata has replicated (the scan that produced the consent already proves the email is known mesh-wide, so in the real flow the email is present). No legitimate "start without a known approved email" case exists.

## 2. Under-block

The route authorizes the START; the actual credential admission is gated downstream by S7 at `/complete` (the minted email must match expectedEmail) and by §6.2 (`isLocallyExecutable`) at selection. This route does not itself verify the device-code login outcome — by design, the completion gate owns that. It also trusts the mandate gate's verdict (the mandate is the authorizer); a mis-issued mandate is the operator's PIN-gated responsibility, not this route's. agentFp resolution that fails (returns a fallback) makes the mandate evaluate DENY (the mandate is party-bound) — safe direction, never an accidental allow.

## 3. Level-of-abstraction fit

Correct layer (R6a option 2): the START runs ON the target machine's own server, driven by the operator from that machine's dashboard after they issue the mandate locally — so the device-code is minted on the machine that will hold the credential and never transits. The mandate check reuses the existing `ctx.coordination.gate` (no new authorization primitive). The email resolution reuses the same authoritative source the scan uses (local pool + replicated meta peer views), extracted into a pure, testable helper rather than re-implemented inline.

## 4. Signal vs authority compliance

This route holds genuine authority (it starts a credential enrollment), exercised through the EXISTING deny-by-default MandateGate — not a new brittle check. The authorization is the mandate (PIN-gated, operator-issued); the route is a consumer of that authority, never a self-grant (requester≠authorizer preserved — the agent cannot issue the mandate). Every uncertain path fails closed (no/denied mandate → 403; unresolvable email → 409). Reference `docs/signal-vs-authority.md`: authority delegated from the operator mandate, deny-by-default, is correctly-placed authority.

## 5. Interactions

Pairs with the existing scan (detection→consent), the S7 `/complete` gate, and §6.2 selection — this route is the missing START link between consent and completion. It does NOT touch the generic `/subscription-pool/enroll` route (normal enrollment unchanged). The configHome slot is per-account (`.claude-followme-<accountId>`), isolated from other accounts. The pending login it issues carries `expectedEmail`, which `completeFollowMe` reads — the two routes compose without shared mutable state beyond the PendingLoginStore (single-flow-per-id discipline). No double-fire (one pending login per start; the wizard's id discipline applies).

## 6. External surfaces

One new HTTP route, dark behind `multiMachine.accountFollowMe` (503 when off — proven by the integration test). It returns a device-code/verificationUrl (already public per the EnrollmentWizard contract). No new config. It is the per-server enroll path (R6a option 2) and does not reach across the mesh itself (the operator drives it on the target's own dashboard).

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local execution BY DESIGN, fed by replicated read-only metadata.** The enrollment runs on the TARGET machine (the one gaining the login); `targetMachineId` is this machine (`ctx.meshSelfId`). The only cross-machine input is the READ-ONLY `subscription-account-meta` projection (the approved email), consumed via the existing peer-views fetch — no credential or configHome crosses. The mandate is verified locally against `ctx.coordination.gate`. This is the intended Mechanism-B posture: each machine mints its own login locally; nothing is replicated except the email metadata used to validate identity.

## 8. Rollback cost

Low. The route is dark by default (no agent runs it until `multiMachine.accountFollowMe` is enabled). No persisted schema change (the configHome slot is created only on a real enrollment; PendingLogin already carries `expectedEmail` from S7). Revert is a single-commit back-out of the route + helper; no migration, no state repair.

---

## Second-pass review

**Concur with the review.** Independent audit of the full route (`routes.ts:20886-20947`), `resolveAgentFingerprint`, the pure resolver, `MandateGate.evaluate` (`:85-135`), `EnrollmentWizard.start`/`completeFollowMe`, and both test files. tsc EXIT=0; 11/11 pass.

1. **Deny-by-default** — missing ids → 400; gate called with the exact action/params/mandateId; `verdict.decision !== 'allow'` → 403 (correctly not `=== 'deny'`). No path starts without allow. Route never issues/widens a mandate (requester≠authorizer).
2. **expectedEmail authoritative (S7)** — resolver reads only `localAccounts` + `peerViews`, never `req.body` (route destructures only `mandateId`/`accountId`); blank/missing → 409 fail-closed, `start` not called. Chain holds: `start` persists expectedEmail, `completeFollowMe` validates it.
3. **agentFp (critical)** — fails closed: a wrong/fallback fp is not a named mandate party → MandateGate step 5 denies. A wrong fp can never produce allow.
4. **configHome isolation** — `accountId.replace(/[^a-z0-9-]/gi,'-')`; `../../etc` → `------etc`, no traversal; per-account slot.
5. **No regression** — routes.ts diff +93/-0 purely additive; generic `/enroll` + `/complete` untouched.
6. **Fail-closed exhaustiveness** — dark→503, missing deps→503, bad body→400, non-allow→403, unresolvable email→409, start throws→500. None start a bogus enrollment.
7. **Test adequacy** — dark→503, denied/no-mandate→403 (zero pending logins), valid→201 (pending carries expectedEmail + correct slot), unresolvable→409, 400; unit covers resolved + all fail-closed branches.

Minor note (not a defect): the integration test stubs `gate.evaluate` (exercises route branching, not real party-binding — that guarantee rests on MandateGate, verified directly).
