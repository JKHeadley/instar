# Side-Effects Review — a second machine no longer goes silent because of state copied from the first

**Version / slug:** `second-machine-copied-config`
**Date:** `2026-10-05`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

instar#2122. Two copied-state defects silenced Luna's second machine:

1. `loadConfig` used `sessions.claudePath` verbatim (`fileConfig.sessions?.claudePath || detectClaudePath()`). A path copied from another machine and absent here made every Claude session die at spawn; each death revoked the session's origin credential, so Telegram replies failed with `invalid-origin-token`. New `resolveConfiguredClaudePath` (src/core/Config.ts) applies the same rule `mergeOperatorBinaryPaths` already applies to `frameworkBinaryPaths`: a path that provably does not exist is ignored in favour of detection, with a warning; a bare name or an unprobeable path is honoured.
2. Registry readers trusted `status === 'active'` alone. A hand-copied registry carried `revokedAt` with `status: 'active'`, so a removed identity whose endpoints are this machine's own stayed a live peer and mesh RPCs looped back (`wrong-recipient`). New `isRegistryEntryActive` (status active AND no `revokedAt`) is used by `getActiveMachines`, `isMachineActive`, `getAwakeMachine`, nickname resolution, `instar machine` status/doctor views, the passkey cell-state route, and the origin pool-audit shard list (which previously enumerated every registry key, revoked or not). `MachineIdentityBootRecovery` already used this exact predicate.

## Decision-point inventory

- Which Claude binary is spawned (config load) — changed only when the configured path provably does not exist.
- Which machines count as active peers — narrowed to exclude entries carrying a revocation stamp.

## 1. Over-block

A configured path that exists is unchanged. A path absent at boot but installed later (e.g. a binary on an unmounted volume) is replaced by the detected binary until the next restart; a warning names both paths. With no detected binary the configured path is kept. A machine with `revokedAt` set is excluded even if someone set it back to `status: 'active'` by hand without clearing `revokedAt`; `IdentityStore.revoke` always writes both fields, and re-admitting a revoked machine is a deliberate re-pair, so this matches intended semantics.

## 2. Under-block

A configured path that exists but is the wrong binary (e.g. a broken wrapper) still spawns dead sessions; that is a separate liveness signal (the "died during startup" warning). The revoke-on-startup-death path itself is unchanged and correct. The other #2122 setup gaps (join LaunchAgent, SIGTERM, git-tracked subscription pool, double Telegram polling, Threadline identity displacement, `instar wakeup` location) are not addressed here and remain open on instar#2122. <!-- tracked: instar#2122 -->

## 3. Level-of-abstraction fit

Config load is the single place the binary path is resolved; the registry predicate sits in MachineIdentity next to the readers. Both reuse rules that already existed one layer over.

## 4. Signal vs authority compliance

No new blocking authority. The path rule replaces a configured path only when a detected binary exists to replace it with; with nothing detected the configured value stands (unchanged behaviour — this also preserves the hermetic-test convention of a placeholder `claudePath` on hosts without claude, which ~250 test files rely on and which the first cut of this fix broke on CI). The registry predicate narrows a peer list; it blocks nothing.

## 4b. Judgment-point check

Not a competing-signals decision point: file existence and a revocation stamp are facts, not heuristics.

## 5. Interactions

Peer enumeration feeds lease, presence, origin evidence, pool views and RPC fan-out; every caller already expects revoked machines to be absent, so excluding half-revoked entries only removes a self-addressed peer. Origin `peerEvidence` no longer picks a ghost peer that resolves to self. Pool audit no longer reports a revoked (or `pending`) shard as unreachable; its peer-URL lookup only ever searched active machines, so those shards were always unreadable and marked coverage permanently incomplete.

## 6. External surfaces

One new boot warning line when a configured Claude path is missing. `instar machine` shows a half-revoked entry as `[revoked]`. The passkey cell-state route reports `revoked` for it. No API shape changes.

## 7. Multi-machine posture (Cross-Machine Coherence)

This change exists for multi-machine. Config resolution is machine-local by design (each machine resolves its own binary). Registry reading is applied identically on every machine; the registry file is not rewritten, so no replication change is needed.

## 8. Rollback cost

Revert the commit; no data or state migration. Pure read-side logic.

## Conclusion

Two small read-side corrections, each reusing a rule already used elsewhere. Live evidence from Luna's Studio: 34 startup deaths that stopped once the path was corrected by hand, and continuous `wrong-recipient` self-RPCs from the half-revoked entry.

## Second-pass review (if required)

Independent subagent reviewer, 2026-10-05: **Concur with the review.** Revoke and restore already write both fields together (`IdentityStore.ts:611-612`), and boot recovery plus IdentityStore already apply the same predicate, so the change brings the remaining readers into line. No caller needs revoked machines; the fallback can only resolve a `claude` binary, so it cannot launch another framework; bare names and backslash-only Windows paths are kept as configured (no change there). Two wording gaps in this review (pool audit also drops `pending`; empty claudePath for non-Claude agents) were folded into §4 and §5 above.
