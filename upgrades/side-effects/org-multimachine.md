# Side-Effects Review — Organization members and keepers across an agent's machines

**Version / slug:** `org-multimachine`
**Date:** `2026-11-16`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

The multi-machine part of `docs/specs/org-members-and-keepers.md` (CMT-1873).

New in `orgPackRoutes.ts`:
- `OrgForwardOp`, `handleOrgForward`, `holdsOrgKey`, `setOrgForward` and `fanOutMemberSide`.
- Only a machine that has received the key machine's published-elsewhere marker forwards (sent at publish and in the start-up catch-up), so agents with no organization, and members, answer exactly as before.
- A router middleware that forwards the admin's members, invitations and keepers routes to the key machine, after checking the principal on the machine that received the request.
- The public `/org/pack/current`, `/org/checkin` and `/org/pack/propose` forward too. Each answers 503 `org-key-machine-asleep` when no machine answers.

Member side:
- `OrgMemberSide.exportForPeer` and `importFromPeer`: the newer `lastAt` wins, the key never changes, and seen removals are merged.
- `org-apply` gains `op: 'member-side'` and `memberSide`.
- `orgStateForPeer` and the start-up catch-up carry the member side.
- The fan-out runs after a join, a consent change, a keeper request and each check-in.

`MeshRpc` gains `org-forward` (same-agent only). `server.ts` wires it: the first peer that doesn't answer `org-key-elsewhere` is the key machine.

## Decision-point inventory

- Forwarded acts — add — the principal is checked where the request arrived; the key machine runs the same functions.
- Member-side import — add — the newer state wins, and a different key is never taken.

---

## 1. Over-block

While the key machine is asleep, the admin's page and members' check-ins answer 503 on other machines; members retry daily.

## 2. Under-block

Two limits are stated, not fixed here:
- On a machine without the key, `/org/status` and `/mobile/org/status` show that machine's own view, which may be older than the key machine's.
- The member and keeper keys travel in `org-apply`, which is signed but not sealed to the receiving machine the way `secret-share` is. They are identity keys for check-ins and proposals; the organization's signing key never travels.



A device act is trusted across the agent's own machines through same-agent MeshRpc, the same trust `org-apply` already uses. Drafting and publishing stay on the key machine, as org-pack specifies.

## 3. Level-of-abstraction fit

No HTTP re-dispatch, so a bearer can never become a device principal. Forwarding calls the same pure registry functions the routes use.

## 4. Signal vs authority compliance

Deterministic only.

## 4b. Judgment-point check

None.

## 5. Interactions

The public check-in on a non-key machine counts against the source-address lane before forwarding.

## 6. External surfaces

None new. The same public routes answer from any machine of the agent.

## 7. Multi-machine posture (Cross-Machine Coherence)

This PR is the multi-machine posture. Status surfaces: the same routes, plus `org-key-machine-asleep`.

## 8. Rollback cost

Revert: non-key machines answer 404 or `org-key-elsewhere` again, and member state stops copying. The published-elsewhere marker file is left inert. No migration.

## Class-Closure Declaration

- `unbounded-self-action` — closure `n/a`: forwarding is one request per incoming request; the fan-out runs once per member-side change.

## Conclusion

Completes CMT-1873.

## Second-pass review (if required)

**Reviewer:** second-pass subagent (two reads)
**Independent read of the artifact: concur** (second read)

The first read did not concur. It found:
- every multi-machine agent forwarded, even with no organization;
- forwarded check-ins and proposals skipped their limits;
- invitations minted on the wrong machine;
- a consent change that a peer's copy could undo;
- unsealed member keys.

The first four are fixed; the fifth is stated in §2. Three minor notes are recorded here:
- The published-elsewhere marker is never removed. A retired key machine leaves peers answering 503 until someone clears the marker.
- A peer that misses the publish fan-out gets the marker only at its next start.
- "Newest change wins" compares clocks on different machines, so a small window exists if they drift.

## Evidence pointers

- `tests/unit/org-multimachine.test.ts`, `tests/integration/org-multimachine.test.ts`.

## Rule-test fix (merge line, 2026-11-16)

The forwarding catch in `orgPackRoutes.ts` answers with an error through `failed()`, but the silent-fallback test reads 20 lines past it into the next route, where `let base: DraftBase | null = null;` matches its "set to null" pattern. The catch now carries the `@silent-fallback-ok` note with that reason.

## Local-verify fix (merge line, 2026-11-17)

Local verify failed with 429 at `org-recovery-copy.test.ts:96`: the keeper/invitation/member recovery rule in `mobilePairingRoutes.ts` shared the `org-acts` device bucket (publish, 5/min) and the test's publishes plus recovery steps drained it. The rule now uses its own `org-admin` bucket (own limit 10/min unchanged). Behind the 429 the test also expected the member at v5 without running the member's update check; it now runs `OrgPackUpdater.tick` and accepts a held update, as `org-pack-and-join.test.ts` does. Result: 1/1 pass. Rollback: revert the bucket name.
