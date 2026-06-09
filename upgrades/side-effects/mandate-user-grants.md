# Side-Effects Review — Coordination Mandate user→agent authority grants

**Version / slug:** `mandate-user-grants`
**Date:** 2026-06-09
**Author:** Instar Agent (echo)
**Second-pass reviewer:** REQUIRED (authority/signing crypto — trust-level decision) — independent adversarial review, see Phase 5

## Summary of the change

Extends the Coordination Mandate so a verified operator can grant a SPECIFIC floor authority to a SPECIFIC Slack user, signed into the mandate so it cannot be forged. This is what lets a non-owner be permitted a floor action (e.g. a prod-deploy) — the Slack permission gate's floor check already calls `GrantStore.activeGrant(slackUserId, scope, now)`; this provides the production, signature-backed implementation.

Files: `src/coordination/types.ts` (the `UserAuthorityGrant` type + optional `grants?` on `CoordinationMandate`), `src/coordination/MandateStore.ts` (the security-critical `canonicalMandate()` change + `addGrants()` re-sign path + `issue()` carrying grants), `src/permissions/MandateBackedGrantStore.ts` (new — reads signed grants, deny-by-default), `src/permissions/index.ts`, `src/server/routes.ts` (PIN-gated `POST /mandate/:id/grants`), `src/server/CapabilityIndex.ts` (route registration), `src/commands/server.ts` (wire the store into the gate).

Decision points touched: the floor-authorization decision (a grant can now clear a floor action for a non-owner) — but only via a SIGNED grant minted on the PIN-gated path.

## Decision-point inventory

- `MandateBackedGrantStore.activeGrant` — **add** — resolves a signed grant → clears a floor action for the named user. Deny-by-default; authorship + mandate-expiry + mandate-revocation + grant-expiry all checked before a grant is honored.
- `canonicalMandate()` — **modify (security-critical)** — grants are now part of the signed bytes (append-only-when-non-empty for backward-compat).
- `POST /mandate/:id/grants` — **add** — PIN-gated issuance (re-signs the mandate with the grant); mirrors `issue`/`revoke`.

---

## 1. Over-block

The grant store is the ALLOW side (it clears a floor action). Over-allow, not over-block, is the risk here — see §4. No legitimate input is wrongly blocked: absent a valid grant, the gate's pre-existing behavior (owner authorizes floor / others refused) is unchanged.

## 2. Under-block (the real risk for an allow-path)

The danger is honoring a grant that shouldn't be honored. Mitigations, all enforced before a grant clears a floor:
- The mandate's `authProof` must verify (the grant is part of the signed bytes — a forged/added grant fails).
- The mandate must not be revoked and not be expired.
- The grant itself must not be expired, and its `expiresAt` is clamped to never exceed the mandate's `expiresAt` (a grant cannot outlive its delegation — enforced at `addGrants` AND at `issue`).
- Match is exact on `grantedTo` (slackUserId) and `floorAction` (no substring/coercion).
Deny-by-default: any check failing → no grant returned.

## 3. Level-of-abstraction fit

Correct. The mandate is already the audited, HMAC-signed authority primitive (requester ≠ authorizer; PIN-gated issuance). User→agent grants are a natural extension of the same signed object — NOT a new parallel authority. The gate consumes grants via the existing `GrantStore` interface (Slice 0), so this is the consume side of an established seam.

## 4. Signal vs authority compliance

**Required reference:** docs/signal-vs-authority.md. This IS an authority (a grant clears a floor action), and it is NOT brittle:
- A grant only has force if it is covered by the mandate's HMAC `authProof`, which is only produced by the PIN-gated issuance path (`MandateStore.sign`). An agent cannot mint or widen its own grant.
- `MandateBackedGrantStore` verifies authorship BEFORE trusting `grants` — it never reads a grant off an unverified mandate.
- The expiry clamp + revoke + mandate-expiry checks are deterministic (no LLM, no heuristic in the authorization path). Fail-closed.

## 5. Interactions

- **Backward-compat (the #1 interaction):** existing signed mandates have no `grants` field; `canonicalMandate()` appends grants ONLY when present + non-empty, so a no-grant mandate serializes byte-for-byte as before → every previously-signed mandate (incl. Dawn's live ones) still verifies. Proven by the backward-compat test (legacy on-disk mandate with no `grants` key verifies TRUE) + the append-only guard in `issue()`.
- **Two `MandateStore` instances:** the gate (built in `commands/server.ts` before AgentServer) uses a second, stateless, READ-ONLY `MandateStore` reader over the same file with the same HMAC derivation (`config.authToken`). It only reads/verifies — no writes — so there's no write race; the writer is the AgentServer/route path.
- **Audit:** every grant decision (allow on accept, deny on reject) is recorded through the existing hash-chained `MandateAudit`.

## 6. External surfaces

- **Other agents / install base:** none by default — no grants exist until an operator mints one on the PIN-gated route; the Slack gate is dark/observe-only. Pure no-op for existing agents.
- **External systems:** none (no new outbound calls).
- **Persistent state:** grants live inside the existing `state/coordination-mandates.json` (no new state file); the field is optional + append-only-when-non-empty.
- **HTTP:** one new PIN-gated route `POST /mandate/:id/grants` (registered INTERNAL in CapabilityIndex + documented).

## 7. Rollback cost

Low / additive. Back-out = revert + patch. Because `canonicalMandate` is append-only-when-non-empty, reverting it does NOT invalidate existing no-grant mandates. The only durable artifact is grants inside mandates; if reverted, a grant-bearing mandate would fail to verify (its proof covers grants the reverted code wouldn't serialize) — but NO deployed mandate carries grants yet, so there is no live signed-grant data to break. No agent-state repair needed for the no-grant fleet.

## Phase 5 — Second-pass review (independent, adversarial)

REQUIRED (authority/signing crypto). An independent reviewer attempted to forge a grant, break backward-compat, and escape the expiry/revoke checks. Verdict appended below.

### Verdict: CONCUR — no exploitable issue found (independent adversarial review)

The reviewer attempted 9 distinct attacks against the live source (forge-a-grant, backward-compat break, expiry-clamp escape, revoke/expiry bypass, privilege confusion, issuance-auth bypass) via a standalone probe script + the full test suite, and could not land an exploit:
- **Forge:** `MandateBackedGrantStore.activeGrant` calls `verifyAuthorship(mandate)` BEFORE reading `mandate.grants` — no path trusts grants off an unverified mandate; a re-signed-with-attacker-key mandate is rejected by the HMAC `timingSafeEqual`.
- **Backward-compat:** `grants` undefined / `[]` / no-key all canonicalize byte-identically to the pre-extension baseline; a legacy on-disk no-grant mandate verifies TRUE.
- **Expiry/revoke:** `activeGrant` skips revoked + expired mandates and past-expiry grants; the effective expiry is `min(grant, mandate)`.
- **Privilege confusion:** strict `!==` equality on `grantedTo` + `floorAction` (no substring/coercion).
- **Issuance auth:** `POST /mandate/:id/grants` is PIN-gated (same timing-safe gate as issue/revoke); Bearer-only → 403.

**One hardening the reviewer flagged — IMPLEMENTED in this change:** the `issue()` library path originally did not enforce the `grant.expiresAt <= mandate.expiresAt` clamp that `addGrants()` does (it was unreachable from any untrusted surface — the issue route drops grants — and neutralized by the query-side clamp, so "hardening, not a blocker"). To make the library contract uniformly safe for any future caller, `issue()` now applies the same validation + clamp (throws on an over-long or malformed grant), covered by a new test (`issue() with grants applies the SAME expiry clamp as addGrants`). Total unit tests: 20.
