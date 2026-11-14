# Side effects: finish a genesis pin interrupted before its anchor

## What changed

Tier 1, 3 source files, about 15 lines, plus one new integration test file (CMT-1437 item 3).

`ConversationGraphDefault.pin()` writes the pinned genesis (`publication.json` and this machine's pin) and only then the publication anchor in the secret store. A crash between the two leaves a pinned genesis with no anchor. Without the anchor, `publication()` looked the genesis up by the paired roster (or the configured genesis choice). When more machines are paired than were signed, and the choice is not configured on that machine (a receiving member such as the M5, or after the choice is removed, since it is read only before genesis), that lookup threw `graph-bootstrap-publication-invalid` on every call. The graph on that machine could never open again, and the peer `pin` request that would have repaired it hit the same throw.

- `GraphCustodyBootstrapStore.selfSignedPublication()`: reads the pinned genesis and verifies it against its own signed members instead of pairing.
- `ConversationGraphDefault.unanchoredPublication()`: used only when no anchor exists. If pairing equals the signed members, the old roster read runs unchanged. Otherwise it finishes the interrupted pin (`pin()` again: recovery envelope, idempotent store pin, then the anchor), but only if this machine is a signed member and every signed member is still paired with its signed keys. Anything else refuses with the same error as before. Once the anchor is written, `publication()` recomputes the roster, which is now the signed members, so the genesis opens on that same call.
- Peer `pin` handler: known pins are now checked against the publication's own members, not the roster computed before the anchor existed. With a non-member paired, the first pin on a machine without the genesis choice failed after pinning and only healed on the next distribute.

Recovery completes; it never rolls back. Rolling back would delete a genesis that peers may already have pinned.

## Decision point

Yes, a read that decides whether local graph evidence is trusted. The new path trusts the pinned genesis only under the same conditions the anchored path uses (signed by the owner, admitted by its writer, this machine a member, members paired with matching keys). No new authority.

## Review

1. **Over-block:** none new. A machine whose signed member was since revoked still refuses, as before; that case needs authenticated recovery, not this path.
2. **Under-block:** the unanchored genesis is trusted without the anchor's hashes. Its owner key comes from the file itself, so the real anchor is the admission signature of a paired, signed member plus the check that this machine is a member. The file is local state (0600, agent state folder) written only by `store.pin`, which runs only after `pin()` checked the recovery binding and, on a receiving machine, after the first-pin holder check; the normal peer `pin` path already anchors what it accepts in the same call. So this adds no new remote way to plant a genesis. The owner control-key check still runs, after the anchor, on the machine that holds that key.
3. **Level of abstraction:** the fix sits where the anchor is read, so every caller (boot, tick, peer requests, routes) gets the same recovery.
4. **Signal vs authority:** authority stays with the signed genesis and the pairing check (`docs/signal-vs-authority.md`). No brittle check gains blocking power.
5. **Interactions:** `publication()` can now write (the finished pin) when it was called from a non-serialized peer request. Calls in one process cannot interleave (`pin()` is synchronous) and the instance lock keeps a second process out. When the machine's own pin file already exists the rewrite is the same bytes; if the crash fell between the publication and pin files, the re-pin signs a new pin, as the interrupted call would have. The roster-equal case is byte-identical to before.
6. **External surfaces:** none. No wire or route change.
7. **Multi-machine posture:** machine-local by design: each machine finishes its own interrupted pin from its own disk. The host's existing distribute then delivers the peer bearer as before.
8. **Rollback cost:** revert the commit. No format change; an anchor written by the recovery is the same anchor the normal path writes.

## Evidence

`tests/integration/graph-default-nonmember-paired.test.ts`, two cases on the real two-member native fixture with a third machine paired and never joined:

- The crash point: the follower's secret store throws on the anchor write during the host's genesis, so the pin is on disk and the anchor is not. The choice is then removed and a fresh process boots over the same state. Before the fix its `restore()` failed with `graph-bootstrap-publication-invalid`; after it the genesis opens on that same boot (what may remain is the host's peer bearer, delivered on the host's next distribute), the anchor exists, the outsider is reported as not joined, and the next owner visits bring both signed members up on the same two-member membership.
- A signed member revoked from the follower's view: the unanchored genesis is still refused and no anchor is written.

## Second-pass review

One fresh Claude reviewer, read-only, from the diff. Concern raised: after finishing the pin, `publication()` still compared the pre-anchor roster (every paired machine) with the signed members and threw `graph-bootstrap-native-roster-transition-unverified`, so recovery came one call later, and the test's assertion was too weak to see it. Fixed: the roster is recomputed after the anchor is written, and the test now requires the boot to open the genesis. It also corrected the trust wording above (the owner key comes from the file) and the race wording. It confirmed the tests reproduce the crash point, that the `receivePin` change is correct, and that a local-only file plus the pairing and membership checks is enough. Not re-reviewed after the fix.

Same class, not changed: `restoreNative()` (standalone only) still reads an unanchored genesis by the paired roster. Standalone has one machine, so a non-member cannot be paired there today.
