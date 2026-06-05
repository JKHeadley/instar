# Side-Effects Review — Vault key coherence (CMT-1038)

**Version / slug:** `vault-key-coherence`
**Date:** `2026-06-05`
**Author:** `echo`
**Second-pass reviewer:** `not required` (crypto algorithm unchanged; resolution/format layers only; every boundary side test-pinned; v1 reads preserved; failure modes strictly improve on today's silent-empty)

## Summary of the change

Three layers killing the key-bifurcation disease: (1) per-agent keychain
accounts (`master-key:<stateDir>`) with read-time adoption of the legacy
global slot (which is never written again); (2) v2 store format with a keyId
header (`'ISv2'|keyId(8)|iv|tag|ct`) so wrong-key is a precise, named error
distinct from corruption — v1 files read forever; (3) dual-key read fallback
(primary first, then the other source, read-only alternates) with a loud
DegradationReporter on divergence and natural convergence on the next write.
Plus: `GET /secrets/sync-status` now reports `vault: {status:'ok'|'empty'|
'decrypt-failed', error?}` instead of masking decrypt-failure as empty.
Keychain ops are injectable (`SecretStoreConfig.keychainOps`) so all of this
is unit-tested against a fake; the #789 real-keychain test guard holds
whenever no fake is injected.

## Decision-point inventory (each side pinned)

1. Per-agent slot present / legacy-only (adopt, global untouched) / neither
   (generate → per-agent slot, NEVER global) — 3 tests.
2. v2 keyId match / no-match (named error, "NOT empty") / matching-key
   corruption (GCM auth error) — 3 tests.
3. v1 primary-key read / v1 fallback-key read (THE incident case) /
   write-after-fallback converges to primary / forceFileKey primary with
   keychain alternate — 4 tests.
4. Guard: no injected fake + VITEST ⇒ file-key only — 1 test.
5. vaultStatus: ok / empty / decrypt-failed (route surface).

## 1. Over-block

Nothing readable today becomes unreadable: every key the old code could
resolve is still a candidate, plus more. The new thrown errors fire ONLY
where today's code also throws (v1, both keys wrong) or silently lied
(reported empty); the route now reports those as `decrypt-failed` instead of
`[]`.

## 2. Under-block

- The legacy global slot remains readable machine-wide until every agent
  adopts — by design (deleting it would break un-migrated agents). It decays
  naturally: nothing writes it, every reader adopts away from it.
- Dual-key fallback widens which keys may open a vault to keys the SAME agent
  resolves from ITS OWN two sources — no new principals, no cross-agent keys.
- Convergence-on-write re-encrypts with the primary; if another process of
  the same agent still resolves only the stale alternate, IT then uses its
  own fallback (now in the other direction) and converges the same way — the
  fixed point is both sources agreeing, reached after adoption.

## 3. Level-of-abstraction fit

Resolution lives in MasterKeyManager (the single key authority); format +
fallback in SecretStore.read/write (the single at-rest codec); the route only
gains a status field. Wire-sync crypto (X25519/HKDF) untouched.

## 4. Signal vs authority compliance

**Reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)
No gating added. Errors got MORE precise; the degradation report is
signal-only; adoption/convergence are self-healing writes within the agent's
own key material.

## 5. Interactions

- Store-first drop persistence (#789), sealed-handoff at-rest, and the sync
  provisioner all read through the same read() — regression suites green
  (21/21).
- Echo's live vault (v1, file-key, keychain slot deleted in the incident
  remediation): reads via primary file key unchanged; first write upgrades to
  v2 with the file keyId. No migration step needed anywhere — resolution-time
  adoption + write-time format upgrade.
- Mixed fleet versions: older readers can't read v2 — but a vault is only
  read by ITS OWN agent on ITS OWN machine (wire sync re-encrypts per peer),
  so the only mixed-version reader of a given file is the same agent
  mid-update, which restarts onto the new code. Residual window ≈ one
  restart; documented.

## 6. External surfaces

`vault` field on sync-status (additive); exported `perAgentKeychainAccount`/
`keyIdOf` helpers; `SecretStoreConfig.keychainOps` (test seam). No config
flags, no migration, no new routes.

## 7. Rollback cost

Revert restores old code — which reads v1 files only. Any vault already
upgraded to v2 would need its 28-byte header stripped (`tail -c +13` of the
post-magic body) — documented here as the rollback runbook; low likelihood
(revert would only follow a fast-caught regression, before fleet-wide v2
rewrites).

## Conclusion

The recurring "vault looks empty" disease removed at its three roots —
shared slot, mute wrong-key failures, single-key reads — with strictly more
diagnosable failure modes and zero operator action.

## Second-pass review (if required)

Not required — see header.

## Evidence pointers

- `tests/unit/secret-store-key-coherence.test.ts` (11, incl. THE incident
  case verbatim and convergence-on-write).
- `tests/unit/secret-store.test.ts` 29/29; secret-adjacent regression suites
  21/21 (store-first integration + sealed-handoff + hardening + e2e).
- `docs/specs/vault-key-coherence.md` + `.eli16.md`. <!-- tracked: CMT-1038 -->
