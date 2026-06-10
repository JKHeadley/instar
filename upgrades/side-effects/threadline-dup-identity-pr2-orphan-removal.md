# Side-Effects Review — Threadline orphan-identity removal (PR2: stop minting identity-keys.json)

**Version / slug:** `threadline-dup-identity-pr2-orphan-removal`
**Date:** `2026-06-09`
**Author:** `Instar Agent (echo)`
**Second-pass reviewer:** `not required (Tier 1 — dead-code removal, no decision surface)`

## Summary of the change

Removes `ThreadlineBootstrap.loadOrCreateIdentityKeys` and the now-dead `identityKeys` field
from `ThreadlineBootstrapResult` (change D of the converged spec
`docs/specs/threadline-duplicate-identity-resolution.md`). That function minted an orphan
`threadline/identity-keys.json` keypair on every agent boot, independent of the canonical
`identity.json` — the exact artifact that became the dead "echo" twin polluting the relay. Its
output was consumed nowhere (verified: zero `.identityKeys` readers in `src/` and `tests/`;
`server.ts` never destructures it). The handshake and relay-client paths source identity via
`HandshakeManager.getOrCreateIdentity()` / `IdentityManager` (canonical `identity.json`) and are
untouched. Files: `src/threadline/ThreadlineBootstrap.ts` (remove function, field, call, return,
two now-unused imports, the orphan-only constant) + `tests/unit/threadline/ThreadlineBootstrap.test.ts`
(delete the orphan-file persistence/permissions/corrupted-regeneration tests, drop the
`result.identityKeys` assertions, add a "does NOT create identity-keys.json" test + a CI guard that
`loadOrCreateIdentityKeys` is absent from the file).

## Decision-point inventory

- No decision point. This removes a write-only code path (`loadOrCreateIdentityKeys`) that gated
  nothing, blocked nothing, and whose output fed nothing. Pure dead-code removal.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

## 2. Under-block

No block/allow surface — under-block not applicable.

## 3. Level-of-abstraction fit

Correct layer: the orphan keypair was a vestige of an older identity model superseded by
`IdentityManager` (canonical `identity.json`). Removing the minting function (not the on-disk file)
is the minimal, right-altitude change. #479 deliberately fenced off this removal as needing its own
spec ("deleting risks the handshake path"); this PR is that spec's change D, and the handshake-path
risk is rebutted with evidence — `HandshakeManager.getOrCreateIdentity()` reads
`{stateDir}/threadline/identity.json`, never the orphan `identity-keys.json` (verified).

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface (dead-code removal).

## 5. Interactions

- **Shadowing / double-fire:** none — the removed function had no callers beyond the single
  bootstrap call site, and its result flowed nowhere.
- **Races:** none — it only wrote an unused file; removing it removes one boot-time fs write.
- **Feedback loops:** none.
- Existing `identity-keys.json` files already on disk become permanently inert (they already were —
  nothing read them since #479). They are NOT deleted by this change (a destructive fleet file-sweep
  is tracked separately, out of scope).

## 6. External surfaces

- **Other agents / relay:** strictly improves coherence — no new orphan identity is ever minted, so
  the duplicate-registration source is closed fleet-wide. No new orphan can be registered on the relay.
- **Persistent state:** stops creating one unused file per agent. Existing inert files left in place
  (no migration). No DB/ledger change.
- **External systems / config / dashboard / CLAUDE.md template:** none.

## 7. Rollback cost

Pure code-deletion. Rollback = revert the PR; `loadOrCreateIdentityKeys` is reinstated and resumes
writing the (unused) file. No data migration, no agent-state repair, no user-visible regression.

---

## Conclusion

Dead-code removal closing the source of the duplicate-identity artifact, paired with the companion
client resolver fix (PR1). No decision surface, no external behavior change beyond ceasing to write
an unused file. The #479 handshake-risk fence is rebutted with verified evidence. 12 bootstrap unit
tests green (including the new "no orphan file" assertion + CI guard); typecheck clean; no other
consumer of the removed field exists. Tier 1: small, low-risk, second-pass not required.

---

## Second-pass review (if required)

**Reviewer:** not required (Tier 1 — dead-code removal, no block/allow or lifecycle decision surface).
