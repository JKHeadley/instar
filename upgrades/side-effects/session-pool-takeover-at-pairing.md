# Side-Effects Review — a new agent's spare machine can take over

**Version / slug:** `session-pool-takeover-at-pairing`
**Date:** `2026-11-05`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 2, driven by the converged and approved `docs/specs/session-pool-takeover-at-pairing.md` (4 rounds, plus the live gate). At an agent's first pairing, both machines now get two new keys:
- `multiMachine.leaseSelfHeal.soloCaptainHold.enabled: true`
- `soloCaptainHold.requireLastingLink: true`

They also get `pairRole` (`inviter` or `joiner`) and `pairedWith`.

Pairing exchanges lasting addresses: LAN, Tailscale or a named tunnel, never a quick tunnel. The new `src/core/lastingLink.ts` records signed proof of a lease exchange over a lasting address in `state/lasting-link.json`.

Until the joiner has proof with `pairedWith`, it does not acquire the lease (`acquireHeldBack`) and does not hold through a lost link (`survivorMayHold`). The inviter serves as it always did.

Supporting changes:
- LAN detection learns Linux interface names.
- A `/32` interface reads as its `/16` in the LAN check.
- A re-pair merges addresses and clears that peer's proof.
- `handlePair` catches async rejections.
- Readiness reports the no-lasting-link reason and its fix.
- `instar pair` and `instar join` print the right note.

Files touched:
- **Source:** `machine.ts`, `server.ts`, `HttpLeaseTransport.ts`, `LeaseCoordinator.ts`, `MeshUrlAdvertiser.ts`, `PeerEndpointResolver.ts`, `PostUpdateMigrator.ts` (reference line), `sessionPoolPairActivation.ts`, `types.ts`, `AgentServer.ts`, `machineRoutes.ts`, plus the new `lastingLink.ts`.
- **Tests:** unit, integration and e2e tiers.

Effort: 4 spec rounds against a cap of 6, and 9 live drill runs. The early runs found five real defects, each fixed here or in its own PR (#2811, #2828, #2833).

## Decision-point inventory

- `acquireHeldBack` — add, invariant. An unproved joiner does not take the lease.
- `survivorMayHold` — modify, invariant. Its new input is proof with `pairedWith`.
- Which addresses count as lasting — add, invariant. A quick tunnel never counts.
- Pair role at a re-pair (`roleForJoiner`) — add, invariant. It takes the opposite of the partner's role, so a pair can never have two joiners.

## 1. Over-block

A pair with no lasting link gets no takeover. This is deliberate (Frontloaded Decision 1). The agent says so, with the fix: same network or Tailscale, then pair again. If a working lasting address loses its first dial while a quick tunnel answers, proof may never form. That fails safe, and readiness reports it.

## 2. Under-block

- **A proved pair whose machines truly lose each other** (both tunnels restart while apart): both hold until they meet. Jobs run twice and pollers conflict. Measured only for a 6-minute cut. Tracked: fb-53e359fb-042.
- **A revoked machine that is still running:** with proof, it keeps holding. Revocation is not pushed to it, and it already holds the bot token. Filed.
- **A long cut:** a duplicate reply remains possible. It was measured at 0 duplicates over 2 cuts (runs 7 and 9).

## 3. Level-of-abstraction fit

The decision sits in the lease layer, where `survivorMayHold` and acquisition already live. Activation rides the existing first-pairing helper, the same as every other pool key. The lasting addresses use the existing `validateMeshEndpoints` and lease-response propagation.

## 4. Signal vs authority compliance

Complies. Proof is a structural fact: a signed answer bound to a nonce and the peer's key. It removes a permission when absent and grants nothing beyond the existing switch when present. No brittle heuristic holds blocking authority.

## 4b. Judgment-point check

No competing-signals point is added. The spec classifies every row as invariant, with reasons.

## 5. Interactions

- The poll gate depends on #2828 (merged). Without it, a joiner that got 409s during a cut and later took the lease could stay silent.
- The Linux self-restart backstop is #2833 (in review). Takeover does not depend on it.
- It enrolls the fast renewal timer (#2803) through the existing switch.
- The allow-list and reply script at join come from #2811 (merged); the drill depends on them.
- A hand-set switch, as on Echo, has no `requireLastingLink` and holds as before.
- Existing pairs receive no keys, because no migration applies.

## 6. External surfaces

- New pairs gain takeover: when the machine in charge dies, the spare answers within about 2 minutes, measured.
- `instar pair` and `instar join` notes change.
- `GET /session-pool/readiness` gives a new reason and fix.
- `/api/pair` request and response carry lasting addresses. This is additive: older peers ignore it, and a pair across releases behaves as the spec's table says.

Linux machines with only predictable interface names may now advertise a LAN address. A `/32` peer address is tried instead of dropped.

## 7. Multi-machine posture

The posture is in the spec:
- `lasting-link.json` is machine-local by design, `hardware-bound-resource`. Each machine proves its own path.
- The keys are written on both sides at pairing.
- Addresses are exchanged at pairing and then kept current by the existing path.
- Notices print once, from the `instar join` the person ran.
- Readiness is per machine.

This feature exists to make the agent one entity across two machines.

## 8. Rollback cost

Set `multiMachine.leaseSelfHeal.soloCaptainHold.enabled:false` on both machines, then restart each. Reverting the release alone does not stop pairs already made on it: an older release ignores `requireLastingLink` and would hold with no proof, which is the split this prevents. The spec states this, and the release note repeats it.

## Conclusion

Ship. Proven live on a fresh pair (run 9: 12/12 single replies through a 30-minute power-off, the holder's return, a 6-minute link cut and the heal). The defects the gate found are fixed.

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent, 2026-11-05 19:17 PST.

**Concur with the review.** It found no rebase damage: the change adds to `joinMesh` and `handlePair` without removing any #2811 code, and #2828 touches only the lifeline. The typecheck is clean, and the 7 changed unit files pass, 165/165.

Both-or-neither serving:
- Before proof, only the inviter serves. `acquireHeldBack` covers only the joiner (`server.ts`) and is checked at the top of `acquireIfEligible` (`LeaseCoordinator.ts`).
- A joiner holding through a handoff self-suspends under the old rule.
- Third machines get no activation.
- Proof needs a valid signature.

All artifact claims were verified against the code.

The reviewer listed four test gaps. Two are now closed:
- Proof from a signed pull, the joiner's real path: `HttpLeaseTransport-mesh.test.ts`, "on a pull is proof only when the peer signed it".
- `acquireHeldBack` covers only the joiner and is passed to `LeaseCoordinator`: `lease-takeover-wiring.test.ts`.

Left as notes:
- An unproved joiner already holding is refused the hold. This follows from `survivorMayHold`, which the wiring test asserts.
- A rebuilt first machine with a new machine id gets no keys at re-pair. It reads as not-first-pairing, which fails safe.

## Evidence pointers

- Spec and report: `docs/specs/session-pool-takeover-at-pairing.md`, `docs/specs/reports/session-pool-takeover-at-pairing-convergence.md`.
- Drill logs (agent home): `.instar/vm-test/takeover-drill-137054/fresh-pair/run9-fixed-stageB.log` (final), plus the earlier `run5-drill.log`, `run6-final.log` and `run7-stageB.log`.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. This is new behaviour plus TypeScript fixes. The existing self-triggered controllers (lease renewal, takeover) gain a precondition, which narrows when they act; no new self-action is added.
