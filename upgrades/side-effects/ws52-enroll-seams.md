# Side-Effects Review — WS5.2: wire the 3 enroll seams (make the follow-me proof work end-to-end)

**Version / slug:** `ws52-enroll-seams`
**Date:** `2026-06-18`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `required (cross-machine + credential enrollment) — appended below`

## Summary of the change

Completes Part B of the approved `ws52-operator-tap-not-text` spec — the connector that turns an operator's Approve into an actual login on the target machine. Driving the proof as the operator (2026-06-18, topic 13481) exposed that Approve issued + delivered the mandate to the Mini fine, but THREE seams were unwired so nothing happened after ("machine logging in now" then silence). This wires all three:

- **Seam #1 — delivered-mandate consumer** (`src/server/AgentServer.ts`): a boot-sweep + 60s tick (`driveDeliveredFollowMeEnrollments`) walks the `DeliveredMandateStore` and, for each account-follow-me mandate not already pending/enrolled, self-POSTs the REAL `/subscription-pool/follow-me/enroll/start` route. Idempotent (skips accounts already in `pending-logins` or the pool — durable, survives restart) and authority-free (the route enforces the dev-gate + deny-by-default + point-of-use mandate re-verify). Re-entrancy-guarded; timer cleared on stop.
- **Seam #2 — peer-view email resolution** (`src/commands/server.ts`): `accountFollowMePeerViews` now sources peers from `_resolvePeerUrls()` (the working pool-scope path) instead of the empty `lastKnownUrl` — falling back to `lastKnownUrl`. This is what the `fetchPeerSubscriptionViews` doc comment always intended. Fixes the `409 "cannot resolve approved account email"` I hit driving enroll-start by hand.
- **Seam #3 — pending-login pool surfacing** (`src/server/routes.ts` + `dashboard/subscriptions.js`): `GET /subscription-pool/pending-logins?scope=pool` fans out to peers' local pending-logins and merges (tagged by machine, dark-peer-tolerant); the dashboard subscriptions controller now polls with `?scope=pool` so a login created on the Mini surfaces on the operator's single dashboard.

## Decision-point inventory
- `driveDeliveredFollowMeEnrollments` (AgentServer) — **add** — nudges the enroll-start route for delivered mandates; carries NO authority itself (route gates).
- `accountFollowMePeerViews` peer source (server.ts) — **modify** — resolvePeerUrls (working) vs lastKnownUrl (empty); fallback preserved.
- `GET /subscription-pool/pending-logins` — **modify** — adds an optional `?scope=pool` merged read; default (no scope) is byte-for-byte unchanged.

## 1. Over-block
No block/allow surface. The consumer only ADDS enroll attempts for mandates the operator already approved+delivered; it never blocks anything. It SKIPS already-pending/enrolled accounts (correct — prevents re-mint), which is the only "rejection" and is the desired idempotency.

## 2. Under-block
The consumer relies on the enroll-start route for all gating (dev-gate, deny-by-default, point-of-use mandate re-verify incl. revocation/expiry). It adds no new trust path — a delivered mandate that fails the route's re-verify still gets 403/409 and no login. The idempotency read (pending-logins + pool) is best-effort; a read failure could cause a redundant enroll-start attempt, but the route itself is the backstop (it re-verifies and the wizard's own pending-login dedup applies), so worst case is a logged retry, never a double-mint of a completed account.

## 3. Level-of-abstraction fit
Correct. Seam #1 is glue at the server layer (where the delivered store lives) that reuses the existing route rather than duplicating credential logic — the lowest-risk placement. Seam #2 swaps a data source to the one the rest of the pool-scope reads already use. Seam #3 mirrors the established `?scope=pool` fan-out pattern (`/sessions?scope=pool`).

## 4. Signal vs authority compliance
**Required reference:** docs/signal-vs-authority.md
- [x] No new brittle authority. The consumer is authority-free (it nudges a route that holds the real authority, deterministically gated). The route's authority is unchanged. Seam #3 is a read-merge. Strictly additive wiring; the failure direction is "no login produced" (safe), never "wrong login" — the email gate (S7) + point-of-use re-verify still hold.

## 5. Interactions
- **Shadowing:** the `?scope=pool` branch is gated on the query param; the default path is unchanged, so existing callers are unaffected.
- **Double-fire:** the consumer's pending/enrolled skip-set + the wizard's own pending dedup prevent re-driving; the re-entrancy guard prevents overlapping ticks.
- **Races:** the consumer reads the delivered store + self-GETs state each tick; a mandate mid-enroll shows a pending login → skipped next tick.
- **Self-call:** the consumer self-POSTs localhost with the agent's own authToken — same-process HTTP, no external surface.

## 6. External surfaces
- Operator dashboard now shows follow-me logins created on OTHER machines (the whole point). No secrets exposed — pending-logins carry only the device-code + verification URL (already the case; the merge just forwards them, machine-tagged).
- Peers are queried at their existing `/subscription-pool/pending-logins` with the agent's authToken (5s timeout, dark-peer-tolerant). No new endpoint exposed to the outside.

## 6b. Operator-surface quality
Touches `dashboard/subscriptions.js` (a one-line URL change to add `?scope=pool`). The rendered surface (the Pending Logins panel) is unchanged in shape — it now simply includes cross-machine logins. Leads with plain language, no raw internals, phone-width (unchanged). N/a for destructive actions.

## 7. Multi-machine posture (Cross-Machine Coherence)
This change EXISTS for multi-machine. Seam #1 is machine-local (each target drives its own delivered mandates). Seam #2 is proxied-on-read (resolvePeerUrls fan-out). Seam #3 is proxied-on-read (the `?scope=pool` merge), dark-peer-tolerant (classified failed entry, never a 500). The login link is the provider's own URL (machine-independent); it surfaces on the operator's single fronting dashboard. Single-machine install: consumer still runs (drives any local delivered mandate); `?scope=pool` returns just local (no peers) — no-op.

## 8. Rollback cost
Revert the commit; ship a patch. No persistent state shape change (uses existing DeliveredMandateStore + PendingLoginStore). The consumer is additive (stops nudging on revert); the `?scope=pool` branch is additive (default unchanged). Behind the existing dev-gate (dark on fleet) — blast radius is dev agents only.

## Conclusion
Wires the three seams that made the proof stall, reusing existing route authority (no new brittle gate), with idempotency that survives restart. tsc clean; new pool-merge integration test (3) + all existing follow-me/enroll route + resolve + peer-view tests green (no regressions). Clear to ship pending the appended second-pass. The TRUE verification — me driving Approve→consumer→enroll→login-link-surfaced on the real machines — is done before this reaches the operator (per the Live-User-Channel-Proof standard I violated last time).

## Second-pass review (if required)
**Reviewer:** independent general-purpose reviewer subagent (read-only), 2026-06-18 — **CONCUR**

Verified all 5 review points against real code (cited file:line): (1) consumer is authority-free (only self-POSTs the real enroll-start route which holds the dev-gate + deny-by-default mandate gate + R4a point-of-use re-verify + S7 email gate), idempotent (handled-set from local pending-logins+pool; PendingLogin.id keyed to accountId so the skip is sound; intra-tick handled.add), re-entrancy-guarded (followMeConsumerRunning, released in finally; serial awaited fetch makes a slow drive skip the next tick not overlap), inert without the store, no secret in logs. (2) seam #2 is a pure data-source swap to resolvePeerUrls (lastKnownUrl fallback, nickname mapped, [] when no peers, authToken unchanged). (3) seam #3 default no-scope path byte-identical; dark peers → classified failed entry never a 500 (AbortSignal.timeout 5s); only non-secret fields (device-code/verificationUrl/machine tags) cross; remote tagged. (4) strictly additive, fails toward "no login produced" — the consumer can't produce a wrong-account login because it passes only mandateId+accountId and the route independently re-derives the email + re-checks exact bounds. (5) no re-mint loop / double-enroll / route hang / auth / missing-await bug. One non-blocking note: the enroll-start self-call has no client-side timeout, which is intentional+safe (start() legitimately runs up to ~180s; the re-entrancy guard, not a timeout, correctly prevents pile-up; the route's EnrollmentDriveError returns a retryable 502 leaving no stuck pending-login). **No concerns.**

## Evidence pointers
- `npx tsc --noEmit` clean (full worktree).
- `tests/integration/pending-logins-pool-merge.test.ts` (NEW, 3) + subscription-enrollment-routes (5) + follow-me-controller-wiring (4) + scan/enroll-start/delivered-mandate route tests (14) + resolve-follow-me-enroll-target (6) + fetch-peer-subscription-views (5) — all green.
