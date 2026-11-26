# Side-Effects Review — the first pairing of a fresh agent hands over its identity

**Version / slug:** `pair-fresh-agent-identity`
**Date:** `2026-11-16`
**Author:** `Echo`
**Second-pass reviewer:** `independent cross-model reviewer (codex CLI), see below`

## Summary of the change

Tier 1: 6 source files and 3 test files (about 150 source lines). Effort: one build, one review round. Feedback fb-1e30d109-e50, from the live two-machine proof of 2026-11-16.

Root cause: only the Threadline relay client creates the agent identity, so an agent made with the relay off had none. `handlePair` then sent no envelope, and the joiner's `not-offered` branch printed "older version". After `registerMachine` added the joiner, `detectJoinedMesh` refused any later mint on the inviter.

The fix has five parts:
- `ensureAgentIdentityForPairing` (new, `src/core/firstPairAgentIdentity.ts`) runs in `handlePair` after the code is validated and before `storeRemoteIdentity`/`registerMachine`. It mints through the guarded `IdentityManager.getOrCreate`, which keeps the joined-mesh refusal.
- The response carries `agentIdentityAbsent {reason, detail}` when there is no envelope, and `agentName`.
- The joiner prints `describeMissingAgentIdentity(...)`, and adopts the inviter's agent name when its own config names none (`joinerAgentNameToAdopt`).
- The SecretStore keychain-write degradation text is corrected: both callers fall back durably.
- The mint-site census test lists the new call site.

## Decision-point inventory

- `handlePair`: mint the identity before registering the joiner (modify). It goes through the existing guarded primitive, which keeps the refusal authority.
- Joiner config: adopt the agent name only when none is set (modify).
- No change to `installAgentIdentityFromPairing` or the transcript checks.

---

## 1. Over-block

Nothing new is refused. A failed or refused mint never fails the machine pairing; it only names the reason.

## 2. Under-block

- An inviter that already lists another machine and has no identity still cannot hand one over. The joiner is now told how to fix it (`instar identity adopt` / `init --standalone`), but nothing is minted. This is intended.
- Agents that are already stuck that way are not repaired automatically.

## 3. Level-of-abstraction fit

The mint belongs at the inviter's first pairing, the last moment it is provably the agent's only machine. Minting at `init` would also work, but it would not repair agents that already exist, and it would change every new agent's boot. The decision of whether minting is allowed stays in `IdentityManager.getOrCreate` (enforced at the minting site, by design).

## 4. Signal vs authority compliance

No new authority. The refusal authority is the existing mint guard; this only calls it at a better moment and reports its answer.

## 5. Interactions

- `decideInviterPairActivation` runs after the mint and still sees the same registry.
- The running server's Threadline/identity components read the identity from disk lazily. The relay is off in this case, and the adoption loop reads disk on its tick.
- The mint-site census is updated.
- The name adoption runs before `installAgentIdentityFromPairing` and before autostart, so the autostart plist name, protected sessions and transcript all use the agent's name.

## 6. External surfaces

- Pairing response gains `agentIdentityAbsent` and `agentName`. Older joiners ignore both.
- A newer joiner paired with an older inviter gets neither field and prints the old text.
- A newly paired fresh agent now has an agent identity (the same key on both machines).

## 6b. Operator-surface quality

The joiner's message is a plain sentence that names the next step.

## 7. Multi-machine posture (Cross-Machine Coherence)

This is the pairing path itself. The identity is replicated by the existing sealed handover, so there is one key on both machines.

## 8. Rollback cost

Revert the commit. Minted identities stay, which is correct: the agent now has one identity on both machines. Adopted `projectName` values stay in the joiner's config and match the agent's real name.

## Conclusion

The fix closes the ordering gap that made a relay-off agent unpairable, and replaces a false message with the real one. It adds no new mint authority.

## Second-pass review (if required)

**Reviewer:** independent cross-model reviewer (codex CLI, read-only, fresh context; given the diff, this artifact, IdentityManager.ts and JoinedMeshDetector.ts).

**Its read: "Concern raised:"**. Each point and what was done:

1. **The guard cannot prove this is the only machine.** A `machines: []` registry, or a lost registry on a former joiner, allows a mint. Qualified: the mint is exactly as safe as the shared guard every mint site uses, and this change adds no weaker path. The detector gaps are pre-existing and filed as feedback (fb-b76115bd-456).
2. **The check and the mint are not one locked transaction.** Two pairings at once on one home contend for the same exclusive file create, and one identity wins (the reviewer agreed). This is an existing property of `getOrCreate`.
3. **An encrypted canonical identity could get a second identity minted beside it.** Valid, and fixed. `ensureAgentIdentityForPairing` now never mints while ANY identity file exists (canonical or legacy), and reports `inviter-identity-unreadable` instead. A test was added.
4. **The name validator accepted `.` and `..`.** Fixed. The name must start with a letter or digit and contain no `..`. Tests were added.
5. **The joiner wrote the adopted name before the handover verified.** Valid, and fixed. The name is now bound for verification and written to config only after `installAgentIdentityFromPairing` succeeds. The E2E test shows the same envelope refused when bound to the folder name, and accepted when bound to the adopted name.

**Status:** points 3, 4 and 5 are fixed. Point 1 is qualified and filed. Point 2 holds.

**Second round (same reviewer, revised diff): "Concur."** It confirmed that the identity-file refusal, the stricter name check and the name written only after verification resolve its concerns, and that the shared detector's pre-existing limits belong in feedback.

## Evidence pointers

- Unit: tests/unit/first-pair-agent-identity.test.ts (9), mint-site census (agent-identity-mint-guard).
- Integration: tests/integration/pair-fresh-agent-identity.test.ts (3), with the existing pairing suites green (52 tests).
- E2E: tests/e2e/pair-fresh-agent-identity-alive.test.ts (production order plus wiring).
