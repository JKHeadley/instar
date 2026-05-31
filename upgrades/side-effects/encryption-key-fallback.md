# Side-Effects Review — loadEncryptionKey legacy-name fallback

**Version / slug:** `encryption-key-fallback`
**Date:** `2026-05-31`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

`MachineIdentity.loadEncryptionKey()` now mirrors `loadSigningKey()` (shipped in
#610): read the canonical `encryption-key.pem`; on ENOENT, fall back to the legacy
`encryption-private.pem` if present, else rethrow. Adds one module constant
`LEGACY_ENCRYPTION_KEY_FILE`.

## Decision-point inventory

- **loadEncryptionKey catch branch** — canonical read throws ENOENT → legacy file
  exists? read it : rethrow. Both branches covered by unit tests (falls back; still
  throws when neither exists).

## 1. Over-block

**What legitimate inputs does this change reject?** Nothing new. It only ADDS a
second lookup location before the same terminal rethrow. Callers that previously
succeeded (canonical present) are unaffected; callers that previously threw ENOENT
with a legacy-only key now succeed.

## 2. Under-block

**What does this still miss?** Only the one known legacy name
(`encryption-private.pem`) is tried, matching the signing-key fallback's single
legacy name — not an open-ended search. A machine missing BOTH the canonical and
the legacy file still throws (correct — there is no key to load).

## 3. Level-of-abstraction fit

**Right layer?** Yes. The fix lives in the single `loadEncryptionKey()` loader that
every encryption-key consumer already calls, directly beside the `loadSigningKey()`
fallback it mirrors. One constant beside `LEGACY_SIGNING_KEY_FILE`. No duplication.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

No blocking authority added. A pure read-path widen with an unchanged terminal
rethrow; gates nothing.

## 5. Interactions

`loadEncryptionKey` feeds the mesh transport's X25519 E2E encryption setup.
Widening it only makes a previously-throwing legacy-keyed machine succeed — no
consumer observes a different value, only present-vs-throw. Idempotent. Pairs with
#610's signing-key fallback so a legacy-keyed machine resolves BOTH keys and its
lease/transport setup completes.

## 6. External surfaces

None. No HTTP routes, config, notifications, or Telegram. The visible effect is the
absence of the `Lease/transport setup: ENOENT … encryption-key.pem` boot warning on
a legacy-keyed machine.

## 7. Rollback cost

Low. Revert the method to canonical-only and drop the constant; a legacy-keyed
machine then re-trips the ENOENT at transport setup. No schema, no migration, no
persisted state.

## Conclusion

Minimal additive read-path fallback, both branches unit-tested, no new authority,
no external surface, cheap revert. Closes the encryption-key half of the legacy-key
defect pair (#610 closed the signing-key half).

## Second-pass review (if required)

Not required — no new blocking authority, no destructive op, both branches tested,
reversible; direct mirror of the already-reviewed #610 fallback.

## Evidence pointers

- `tests/unit/machine-identity.test.ts` — loadEncryptionKey legacy fallback + still-throws.
- 68 machine-identity tests green; `tsc --noEmit` clean.
- Found live on the mini: `Lease/transport setup: ENOENT … encryption-key.pem`
  after #610 resolved the signing key.
- Spec: `docs/specs/encryption-key-fallback.md` (+ `.eli16.md`).
