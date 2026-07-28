# Side-Effects Review — Headless secret-sync key-policy inheritance

**Version / slug:** `headless-secret-sync-key-policy`
**Date:** 2026-07-18
**Author:** Instar Agent (instar-codey)
**Second-pass reviewer:** not required

## Summary of the change

The inbound and outbound secret-sync `SecretStore` instances in `src/commands/server.ts` now inherit `config.secrets.forceFileKey`. This closes `fb-3fef9df5-80a`: a headless joined home that deliberately selects file-key persistence no longer has that policy silently discarded by the secret-sync composition root. A source-level wiring ratchet in `tests/unit/secret-sync-key-policy-wiring.test.ts` pins both construction sites.

## Decision-point inventory

No judgment or block/allow decision is added or modified. The change passes an existing machine-local key-storage policy into two existing stores.

## 1. Over-block

No block/allow surface — over-block not applicable.

## 2. Under-block

This does not automatically infer that every headless machine should use a file key. A joined home must still set the existing `secrets.forceFileKey` policy when its daemon cannot reliably access the OS keychain. That is intentional: silently mirroring every keychain-backed key to disk would weaken the operator's selected at-rest posture.

## 3. Level-of-abstraction fit

The fix belongs at the production composition root. `SecretStore` already owns key selection and durable file creation; secret sync should consume that primitive with the same config used by other store writers, not reimplement key persistence or infer daemon capabilities.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

It is deterministic configuration propagation into an existing storage primitive, not a semantic detector or authority.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The existing explicit operator configuration remains authoritative.

## 5. Interactions

- **Shadowing:** none; the option reaches the same `MasterKeyManager` path used elsewhere.
- **Double-fire:** none; no new event or writer is added.
- **Races:** unchanged; each store retains its existing atomic ciphertext write.
- **Feedback loops:** none.
- **Adjacent paths:** both inbound writes and outbound reads now agree on the primary key source, preventing one side from producing ciphertext the other side cannot reopen after restart.

## 6. External surfaces

No API schema, notice, URL, timing contract, or operator action changes. Persistent ciphertext written after the change may use the configured file-backed master key, as the existing option already promises. No secret value is exposed.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local by design:** the encrypted vault and its master-key backend are a per-machine security boundary. Secret values replicate through the existing recipient-encrypted `secret-share` mesh path; the at-rest key itself never crosses machines. The change emits no notices, creates no URLs, and adds no topic-bound durable state.

## 8. Rollback cost

Pure composition change: revert the two constructor options and ship a patch. No schema or migration is introduced. Vaults already written with file-backed keys remain readable through `SecretStore`'s existing dual-key candidate logic.

## Conclusion

The review found no competing authority or new side-effect surface. Honoring the existing explicit key policy is narrower and safer than introducing headless detection or universal disk mirroring. The targeted wiring and key-coherence tests plus the full repository lint/build gate are green; clear to ship.

## Second-pass review (if required)

Not required: this does not change messaging acceptance, dispatch, session lifecycle, recovery, or a guard/gate/watchdog.

## Evidence pointers

- `tests/unit/secret-sync-key-policy-wiring.test.ts`
- `tests/unit/secret-store-key-coherence.test.ts`
- Topic 458 two-machine canary report: mutation/tombstone/symmetric restart passed; the unconfigured headless receiver reproduced vault loss, and file-key configuration survived restart.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no self-triggered controller — not applicable.
