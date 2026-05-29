# Side-Effects Review — Session Pool Track B (part 1): Machine Nicknames

**Spec:** docs/specs/MULTI-MACHINE-SESSION-POOL-SPEC.md §L2 (approved, review-convergence stamped)
**Track:** B part 1 (machine nicknames — the user-facing handle). Ships DARK (no route/UI yet).
**Files:** src/core/NicknameAssigner.ts (new), src/core/MachineIdentity.ts, src/core/types.ts

## What changed
1. **`NicknameAssigner.ts` (new, pure):** `assignNickname()` / `deriveBaseNickname()` / `isValidNickname()`. Derives a friendly, deterministic, collision-free nickname from a machine's hostname (title-cased) → platform-arch fallback → numeric suffix on collision. No I/O.
2. **`MachineRegistryEntry.nickname?` (types.ts):** new OPTIONAL field (backward-compatible — registries written before §L2 simply have no nickname).
3. **`MachineIdentityManager` (MachineIdentity.ts):**
   - `registerMachine()` now auto-assigns a nickname when absent — IDEMPOTENT (a re-register keeps the existing nickname and preserves `pairedAt`; it spreads the existing entry so no field is lost). Collision set = every other machine's nickname.
   - `updateNickname(machineId, nickname)` — validates format + pool-uniqueness (case-insensitive, excluding self); a collision THROWS (not silently suffixed). Metadata-only — never moves a session or touches lease/ownership.
   - `resolveNickname(name)` — case-insensitive, trimmed, active-only lookup → machineId | null (consumed by L4 placement/transfer commands; never silently mis-routes).

## Blast radius
- `registerMachine` is called at identity creation + pairing + role changes. The change is additive (adds a nickname field) and idempotent. The entry-spread (`...(existing ?? {})`) preserves all prior fields incl. seamlessness fields (syncSequence, authoredUnderEpoch, etc.) — verified the existing 64 machine-identity tests pass unchanged, plus `pairedAt` is now preserved on re-register (previously reset — a latent improvement).
- The nickname field is optional + unused by any runtime path yet (no route/UI until Track B part 2) — purely additive data.

## Risk + mitigation
- **Risk:** `registerMachine` re-register previously reset `pairedAt`/role to fresh; now it preserves `pairedAt` and existing fields. **Mitigation:** this is strictly more correct (pairing time shouldn't reset on a role change); covered by the idempotency test. Role/lastSeen still update.
- **Risk:** nickname collisions across machines. **Mitigation:** auto-assign disambiguates with a numeric suffix; manual updateNickname rejects collisions outright. Tested both paths.

## Migration parity
- No config/migration needed — the `nickname` field is optional and auto-populated on the next `registerMachine` (which runs at boot via `ensureSelfRegistered`). Existing registries without nicknames get one assigned on the next registration; absent until then (handled as optional everywhere).

## Rollback
- Additive + dark. Remove the field + the three manager methods + NicknameAssigner.ts to revert; no data migration to undo (the field is optional).

## Tests
- tests/unit/NicknameAssigner.test.ts (9) — derivation, collision, validation, determinism.
- tests/unit/machine-nickname.test.ts (9) — auto-assign + idempotency + disambiguation + update validation/uniqueness + resolve (case-insensitive, active-only, revoked-excluded).
- 18 new green; existing 64 machine-identity tests unchanged; tsc clean.

## Agent awareness
- Deferred to Track B part 2 (the `GET /pool` route + Machines dashboard tab) where the nickname becomes user-visible — that's where the CLAUDE.md Tier-0 blurb + Playbook trigger land, per the spec's Agent Awareness section. <!-- tracked: session-pool-track-b -->
