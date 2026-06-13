# Side-Effects Review — Live credential re-pointing (Increment A, Step 6b: census re-routing — registry + QuotaPoller)

**Version / slug:** `live-credential-repointing-increment-a-census-quotapoller`
**Date:** `2026-06-13`
**Author:** `echo`
**Second-pass reviewer:** `not required` (additive read re-routing, provably NO-OP while dark — verified both sides of the one behavior boundary; no blocking authority, no session spawn/kill/recovery)

## Summary of the change

The process-wide resolver registry + the first three §2.2 census re-routes (the QuotaPoller's location reads), shipping **dark**.
- **Registry** (`CredentialLocationResolver.ts`): `credentialLocationResolver()` (getter) / `setCredentialLocationResolver` (wired at Step-7 startup) / `resetCredentialLocationResolver` (tests). Defaults to a NO-OP resolver whose `active()` is always false — so every consumer that routes through it keeps EXACTLY today's behavior until the real resolver is wired AND the feature enabled.
- **QuotaPoller census #1** (`defaultTokenResolver`): reads the token from `resolver.slotForAccount(account.id, account.configHome)` — the account's CURRENT slot, not its enrollment home.
- **QuotaPoller census #2** (the 401-refresh closure): refreshes the token in the account's current slot (refreshing the enrollment home post-swap would rotate the WRONG tenant's token). The Step-4b funnel lock already serializes the write.
- **QuotaPoller census #3** (the email auto-patch in `pollAll`): SUPPRESSED while the ledger is active — it reads the enrollment home's login record, which after a swap holds a different tenant's email and would cross-contaminate the pool's email→account map.

Tests: registry (2) + census #3 suppression both-sides (2); the existing 13 QuotaPoller tests prove the dark/no-op path is unchanged.

## Decision-point inventory
- The resolver registry's no-op default — **add** — the structural guarantee that re-routing is a no-op until wired.
- Census #3 suppress-when-active — **add** — a fail-safe: while the ledger is authoritative, the enrollment-home email is not trusted into the pool. The DARK path is unchanged.

---

## 1. Over-block / 2. Under-block
No block/allow surface. Census #3's suppression is not a content gate — it withholds a stale write while the ledger is the location authority; the divergence it would have surfaced is the identity audit's job (a later step). Dark → the patch runs exactly as today (tested).

## 3. Level-of-abstraction fit
Correct — the consumers route through the one resolver (Structure beats Willpower) rather than each re-implementing the enabled/seeded branch. The registry mirrors the `credentialWriteFunnel` singleton precedent.

## 4. Signal vs authority compliance
Compliant — the resolver is read mechanism; the re-routes change WHERE a read happens (no-op while dark), not WHETHER an action is allowed. No brittle blocking authority. **Second-pass not required** — additive read re-routing, no-op while dark, no session/dispatch/messaging decision.

## 5. Interactions
The QuotaPoller refresh write (#2) shares the Step-4b per-slot funnel lock with the swap and any other refresh — already serialized. The reads (#1) are sync + never throw. No double-fire; the registry is a single process-wide var.

## 6. External surfaces
None new — no routes/network/notices. While dark, byte-identical behavior.

## 7. Multi-machine posture (Cross-Machine Coherence)
**Machine-local BY DESIGN** — the QuotaPoller polls this machine's accounts against this machine's ledger/keychain. The registry is a per-process var. No shared state.

## 8. Rollback cost
Low — additive; `git revert` removes the registry + the three re-route lines. No migration, no persisted state. While dark there is no behavior to roll back.
