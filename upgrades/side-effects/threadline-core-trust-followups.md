# Side-Effects Review — threadline-core step-3 follow-ups (paused pin, SEC-16, invite-store degradation)

**Version / slug:** `threadline-core-trust-followups`
**Date:** `2026-10-20`
**Author:** `dawn`
**Second-pass reviewer:** `independent reviewer subagent (see Second-pass review below)`

## Summary of the change

Three follow-ups Echo named in her review of #2226 (rollout step 3 of `docs/specs/threadline-standalone-pairing.md`).

- **A, paused pin.** `AgentTrustManager.demoteInvitePairing` now records `invitePausedReason` on the profile. `getProfileByFingerprint` exposes it to threadline-core's `InviteTrust` as a non-enumerable getter `via` = `paused: <reason>`, so it is never written to the trust file. It is cleared by the three operator re-confirmations: `markInviteVerified` (a completed invite pairing), `recordInviteAccepted` (the operator approved a NEW invite from that agent, which is the remedy the spec gives for a pause) and `markMutualVerified` (a 12-word confirm). Core's recipient `handleFinish` already refuses when `via` starts with `paused:`. Before this change that check never fired in Instar, so a late Finish could re-promote a demoted pin.
- **B, SEC-16.** A small-order or non-canonical identity key (core's `isAcceptableIdentityKey`) is refused by `recordInviteAccepted`, `markInviteVerified`, `startStaticPairing` (new outcome `unacceptable-key`, which the pairing route maps to a 409), `recordPendingVerification` and `inheritReplicatedVerification`.
- **C, invite-store degradation.** The bootstrap `catch` around the invite store and engine now calls `DegradationReporter.report` (feature `Threadline.pairingInvites`) instead of `console.error`. That puts it in `/health` (`getRecentEvents`) and the degradation digest.

Test fixtures that pinned synthetic hex strings (`'deadbeef'.repeat(8)`, `'f'.repeat(64)`, random 32 bytes) now use real Ed25519 keys. The never-swap test's imposter key is drawn until it is a valid curve point, so that test still exercises the never-swap rule rather than the new weak-key check.

## Decision-point inventory

- Recipient Finish for a paused pairing: refused (was: accepted and promoted). The check is core's; this change only makes Instar's trust store answer it.
- Pinning a weak key: refused on 5 paths (was: accepted).
- No change to who may approve, to the credential gate, or to trust levels.

## 1. Over-block

A real Ed25519 public key is never small-order or non-canonical, so no genuine agent is refused. Code or tests that pinned made-up hex strings now get `false` or `unacceptable-key`. Three test files did, and their fixtures were fixed. A paused pairing refuses a legitimate late Finish. That is the intended outcome of a pause (spec §4.4.2), and the operator recovers by sending a new invite.

## 2. Under-block

The pause marker is machine-local. Other machines of the same agent drop the pairing through the existing replication revoke on demote. They do not see the pause reason, and they do not need it: their copy is revoked rather than paused.

A first draft cleared the marker only in `markInviteVerified`. That would have over-blocked: the remedy for a pause is a new invite, and accepting the new invite left the marker set, so its Finish would have been refused as well. The marker is now also cleared when the operator approves a new invite and on a 12-word confirm, and a test covers the new-invite case end to end.

Keys pinned before this change are not re-checked: the weak-key refusal runs at pin time, by design. No real agent's key is weak, and a re-check of stored pins would need a migration with no case to justify it.

## 3. Level-of-abstraction fit

The paused rule and the weak-key predicate live in threadline-core. Instar's trust store now gives the rule the state it needs and reuses the predicate rather than copying it. The degradation goes through the existing reporter.

## 4. Signal vs authority compliance

No new authority. A and B narrow what an inbound message or a supplied key can do, and C is a signal.

## 4b. Judgment-point check

No LLM judgment involved. A deterministic cryptographic check is the right shape for "is this a curve point".

## 5. Interactions

- The trust file gains an optional `invitePausedReason` field. Older Instar ignores it.
- `via` is a getter, so `JSON.stringify` and `{...profile}` do not carry it. Only the invite engine reads it.
- `startStaticPairing`'s union gains `unacceptable-key`. Its one caller (`POST /threadline/pairing/:peerFp/start` in routes.ts) handles it.
- `DegradationReporter` dispatches to the Remediator or the attention queue like every other `report()`. This fires only at bootstrap, so at most once per boot.

## 6. External surfaces

The pairing start route can return a 409 with a new message, and `/health` can list `Threadline.pairingInvites`. No wire format changes.

## 7. Multi-machine posture (Cross-Machine Coherence)

The pause is local plus a revoke, as described in §2. The weak-key check runs on each machine's own pinning paths, including inherited records, so a replicated record carrying a weak key is refused on arrival.

## 8. Rollback cost

Revert the commit. A leftover `invitePausedReason` field is ignored by the old code.

## Conclusion

This closes the three gaps Echo found, with tests on the real engine and the real bootstrap. Each code change was mutation-checked.

## Evidence pointers

- `tests/unit/threadline/threadline-core-trust-followups.test.ts` (12 tests)
- `tests/e2e/threadline/pairing-invite-store-unreadable.test.ts` (2 tests)
- Mutation runs: 10 mutants on AgentTrustManager (demote marker, getter attachment, each of the 3 clears, SEC-16 on each of 5 paths) and 1 on the bootstrap catch. All 11 were killed.
- `tests/unit/threadline/threadline-core-trust-followups.test.ts` now has 12 tests, including "after a pause, a NEW invite completes" and "a 12-word confirm clears the pause".

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (read-only, 2026-10-20), required because the change narrows what an inbound Finish can do and adds refusals on trust-pinning paths.
**Independent read of the artifact: concur**

Checked: core's `handleFinish` reads `via` only before a first Finish promotes, so a paused pin cannot be re-promoted by a replayed Finish. `recordInviteAccepted`, which now clears a pause, is reached only through `approveAccept`, which only the operator's Telegram tap or the PIN-gated dashboard route calls, so an inbound message cannot clear a pause. The `via` getter is on the live profile object that the engine reads directly, with no clone in between. Every `peerIdentityPub` write site in `AgentTrustManager` is preceded by the weak-key check. The fixture changes keep each test's intent.

## Review notes from #2229 (Echo, non-blocking), 2026-10-20

- `inheritReplicatedVerification` clears the pause only when its `verifiedAt` is present and strictly later than `invitePausedAt`, a new persisted field that `demoteInvitePairing` records. Otherwise it pins the key as before and keeps the pause. The first version of this commit cleared the pause unconditionally, reasoning that the demote's revoke tombstone stops older verifications from arriving. Echo found that premise unenforced: nothing in src calls the inherit path yet, `emitRevoke` is best-effort (try/catch, and a no-op without replication), and the replicated store keeps a concurrent put and tombstone as two versions, either of which could be inherited. So an older verification minted before the pause could clear it. The guard now rests on the local timestamp comparison, not the tombstone. Times are compared with `Date.parse`; a missing or unparsable `verifiedAt` counts as not later. `verifiedAt` comes from the other machine's clock, so if that clock runs behind, a genuinely newer confirm can look older and the pause stays. That is the safe direction and is deliberately left that way. `invitePausedAt` is cleared wherever `invitePausedReason` is. Tests: newer clears; older, equal, missing and unparsable all keep the pause; the pause time survives a restart. Mutants: the unconditional clear, a missing or unparsable time counted as later, string comparison, `>=`, no clear at all, the pause time not recorded, and `markInviteVerified` keeping it. All are killed. One planned mutant (missing time read as `Infinity`) proved equivalent, because `Number.isFinite` already rejects it.
- A comment at the `via` getter says core must read the profile only through `getProfileByFingerprint`: a clone or spread drops the getter, and a paused pin would then read as not paused.
- Added to §2: keys pinned before this change are not re-checked.
