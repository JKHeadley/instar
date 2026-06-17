# Side-Effects Review — WS5.2 §5.3/S7 email-gate at follow-me enrollment completion

**Version / slug:** `ws52-account-follow-me-email-gate`
**Date:** `2026-06-17`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `pending (high-risk: credential boundary / email-identity gate / account selection)`

## Summary of the change

WS5.2 §5.3/S7. Wires the (PR2) `validateEnrolledAccountEmail` gate into the follow-me enrollment-completion path so a freshly-minted account's email is validated against operator expectation BEFORE the account becomes a selectable pool member. Threads `expectedEmail` from `EnrollmentWizard.start()` → `PendingLoginStore.issue()` → the `PendingLogin` record. Adds `EnrollmentWizard.completeFollowMe(id, nickname)`: completes the login (reusing sync `complete()` so interactive-readiness still runs), reads the COMPLETED account's email via an injected `IdentityOracle` (`CredentialIdentityOracle.resolveSlotTenant(configHome)` → the provider profile endpoint), runs the gate, and returns `validated` (verified match) | `held` (mismatch/missing/unverifiable → emits a HIGH attention item, account NOT selectable) | `not-found`. Adds a dark route `POST /subscription-pool/follow-me/enroll/:id/complete` that calls `SubscriptionPool.add()` ONLY on `validated`. Wires the oracle + attention emitter into the wizard in `server.ts`. Files: `PendingLoginStore.ts`, `EnrollmentWizard.ts`, `routes.ts`, `server.ts` + 3 test files. Dark behind `multiMachine.accountFollowMe`.

## Decision-point inventory

- `EnrollmentWizard.completeFollowMe()` — **add** — the S7 decision: a completed follow-me login becomes selectable IFF its real email matches the operator-approved email.
- `POST /subscription-pool/follow-me/enroll/:id/complete` — **add** — dark route; the only path that calls `add()` for a follow-me account, gated on `validated`.
- `PendingLoginStore` / `StartEnrollmentInput` `expectedEmail` — **add** — data carried from issuance to completion (the operator-approved email travels with the pending login).

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

A legitimate enrollment whose account genuinely matches the operator's expectation but whose email the oracle cannot read (profile endpoint down, transient network failure) is HELD, not added — the operator sees a HIGH attention item rather than the account silently appearing. This is deliberate fail-closed behavior (S7: never auto-select an unverified account). The cost is a retry/attention rather than a silent success; this is the correct trade for a credential gate. It does NOT affect normal (non-follow-me) enrollment at all — `complete()` is unchanged and the generic `/enroll/:id/complete` route is untouched; only the new follow-me route runs the gate.

## 2. Under-block

**What failure modes does this still miss?**

The gate validates EMAIL identity, not token validity or scope — a matching-email account whose token is later revoked is caught downstream (provider 401 + §6.2 selection gate excludes a needs-reauth account), not here. It also trusts the oracle's profile read: if the provider profile endpoint itself returned a wrong email (provider-side compromise), the gate would accept it — but that is outside instar's trust boundary (the same endpoint authenticates the account). The host-allowlist validation of a target-supplied verificationUrl (the other half of S7/R6) is a separate concern owned by the enroll-drive path, not this completion gate.

## 3. Level-of-abstraction fit

Correct layer. The email-identity decision belongs at enrollment completion — the single moment the minted account first exists and before any selection can reach it. The gate LOGIC lives in the already-shipped `AccountFollowMeEmailGate` (PR2); this change only WIRES it at the completion chokepoint + adds the data (`expectedEmail`) it needs. The wizard reads identity via the existing `IdentityOracle` abstraction rather than re-implementing a profile fetch. `SubscriptionPool.add()` stays the single pool-mutation point; the route gates it. No lower/higher layer is a better fit.

## 4. Signal vs authority compliance

This gate holds genuine authority (it decides whether an account becomes selectable), and that is appropriate: the decision is DETERMINISTIC (a normalized string-equality of two emails), not a brittle heuristic. It fails CLOSED on every uncertainty (no oracle, unreadable email, missing expected email, mismatch → held). It does not block any user message or outbound action — it only withholds a credential-bearing account from the selectable set and surfaces a HIGH attention item for the operator to resolve. Reference `docs/signal-vs-authority.md`: a deterministic, fail-closed credential-admission gate is authority correctly exercised, not a brittle blocker.

## 5. Interactions

`completeFollowMe` reuses the existing sync `complete()` (so `ensureInteractiveReady` still runs for claude-code homes) and then layers the gate — no double-completion (the pending login transitions to `completed` exactly once). It does NOT touch the generic `complete()` path, so normal enrollment is byte-for-byte unchanged. The validated account enters the pool via the SAME `SubscriptionPool.add()` validation as a manual add (configHome non-empty, no-credential guard) — and §6.2's `isLocallyExecutable` then governs its selection. The attention item id is deterministic (`account-follow-me-email:<accountId>:<nickname-slug>`) so repeated held completions de-duplicate rather than flooding (P17). No race with adjacent cleanup.

## 6. External surfaces

One new HTTP route, dark behind `multiMachine.accountFollowMe` (503 when off — proven by the integration test). A HELD completion raises ONE HIGH attention item (operator-visible, deduped by deterministic id). No change visible to other agents/machines. The route is the per-server completion path (R6a option-2: the operator drives the target machine's own enroll route); it does not reach across the mesh.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN** (per the chosen R6a option-2 / OQ6 resolution). The enrollment completes ON the target machine, against the credential that machine just minted into its OWN config-home, validated by THAT machine's oracle against the operator-approved email carried on the local pending login. Nothing replicates: the account becomes selectable only on the machine that holds its login. This is the intended posture — a per-machine login is the ToS-safe Mechanism-B model; "the account works on every machine" is achieved by each machine running this completion for its own enrollment, never by moving a credential. The attention item on a held completion surfaces on the target machine's operator surface.

## 8. Rollback cost

Low. The route is dark by default (no agent runs it until `multiMachine.accountFollowMe` is enabled). `expectedEmail` is an optional additive field on `PendingLogin` (no migration — old records simply lack it; the gate fails them closed, which is safe). Revert is a single-commit back-out; no persisted-state repair (a pending login is ephemeral, TTL-bounded). No data migration.

---

## Second-pass review

**Concur with the review.** Verified by reading source (not author framing):

1. **Fail-closed completeness** — traced every path in `completeFollowMe`: no oracle → `completedEmail=null`; `{unavailable}` → null; oracle throws → caught → null; empty `configHome` → no token → unavailable → null; missing `expectedEmail` → gate `missing-expected-email`; mismatch → `email-mismatch`. Every non-match path returns `held`; `validated` requires real normalized email equality. No credential-less/unverified account can reach `validated`.
2. **Route only adds on validated** — `subscriptionPool.add()` is reached only after `not-found`(404) and `held`(200) are exhaustively returned; the gate runs before any pool mutation. Dark gate matches the PR2 scan-route pattern exactly; no path collision with the generic route.
3. **No regression** — generic `complete()` and `POST /subscription-pool/enroll/:id/complete` are byte-unchanged (pure addition); `completeFollowMe` REUSES `complete()` (ensureInteractiveReady still runs); no double-transition.
4. **expectedEmail threading** — flows start()→issue()→record (trimmed, omitted-when-blank) and is read from `login.expectedEmail`. An old pending login without it fails closed (`missing-expected-email`).
5. **server.ts wiring** — `CredentialIdentityOracle` + `telegram` in scope; emitAttention maps to a valid `priority:'HIGH'` createAttentionItem. `tsc --noEmit` EXIT=0.
6. **Attention flooding** — deterministic attention id de-dupes repeated held completions.
7. **Test adequacy** — both boundary sides covered via the REAL route pipeline (dark→503, validated→201+pool added, held→200+pool NOT mutated+HIGH attention, 404); units assert fail-closed on oracle-unavailable/no-oracle/throws/missing-email. 33/33 green.

Minor non-blocking note: gate normalizes case for comparison while the store preserves case on `expectedEmail` — correct (no false mismatch on case).
