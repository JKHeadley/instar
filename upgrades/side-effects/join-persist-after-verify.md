# Side-Effects Review — instar join saves nothing from the reply until the agent identity verifies

**Version / slug:** `join-persist-after-verify`
**Date:** `2026-11-17`
**Author:** `Echo (security effort, topic 143781)`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1: one source file (`src/commands/machine.ts`), one test and two docs.

`joinMesh` saved parts of the pairing reply before or regardless of the agent-identity envelope check. Everything from the reply is now saved only when the handover verifies:
- the out-of-envelope owner introducers and recovery bearer;
- the peer registration (identity, awake role, URL, endpoints);
- the pairing keys and the Telegram handover (pair activation).

If the handover does not verify, the join prints a plain "not finished" line, installs no auto-start, and exits 1. Before, it printed "Joined … as standby".

Also:
- A plain-http join to a non-local, non-Tailscale address prints a warning.
- The stale "verify the visual symbols match" line is removed.
- The recovery-bearer write is now wrapped so a bad config file cannot skip the rest of the join.

Class of problem: state from an unauthenticated network reply was persisted before (or without) the authentication check.

## Decision-point inventory

- Join persistence: modify, to persist only after the deterministic envelope check.

---

## 1. Over-block

- **Not-offered** (the inviter sent no envelope): the join now stops instead of half-finishing. Every inviter has sent the envelope since 2026-08-20, so not-offered now means the inviter has no identity or its seal failed. That join was already reported as unfinished ("NOT minting"). The operator re-pairs with a fresh code.
- **Plain-http warning:** it only warns and never refuses.

## 2. Under-block

Named residuals:
- Without `--agent-fingerprint`, a listener that knows the pairing code could forge a self-consistent envelope, so the gate fully protects pinned joins only. The plain-http warning covers the main way the code leaks.
- The introducers could travel inside the sealed envelope (a protocol change).

## 3. Level-of-abstraction fit

One gate, at the single point where the handover outcome is known.

## 4. Signal vs authority compliance

- [x] Deterministic: the envelope verification result.

## 4b. Judgment-point check

No new heuristic.

## 5. Interactions

- Name adoption was already gated.
- Pair activation reads its config from disk; the saves stay before it when the handover verifies.
- The recovery bearer is also pulled from peers at boot, so a failed save still recovers.

## 6. External surfaces

CLI output only.

## 6b. Operator-surface quality

A failed handover now ends with one plain line saying what happened and what to do, instead of a misleading "Joined".

## 7. Multi-machine posture

The joining machine's own config and registry.

## 8. Rollback cost

Revert and ship a patch.

---

## Conclusion

Closes the class for the join path. Clear to ship.

---

## Second-pass review

**Reviewer:** independent reviewer subagent (Claude, fresh context, read the whole join path and the inviter side)

**Independent read:** concur, with concerns, now addressed.

- **Fixed:** peer registration, pairing keys and the Telegram handover were still saved on a refused join. They are now gated, and the join stops.
- **Fixed:** a refused join reported success and installed auto-start. It now exits 1 with a plain line.
- **Fixed:** the bearer write could throw past the identity install. It is now wrapped.
- **Fixed:** Tailscale and `*.localhost` addresses were warned about wrongly. They are now exempt.
- **Confirmed:** no later step needs the fields before the gate.
- **Confirmed:** the not-offered behaviour change is right, since every inviter sends the envelope.
- **Named in §2:** forgeability of unpinned joins.

---

## Evidence pointers

`tests/unit/join-persist-after-verify.test.ts` runs a real join against a stand-in listener that offers introducers, a recovery bearer, a machine identity and endpoints, but no valid envelope.
- **After the fix:** nothing under `.instar` names the planted peer, neither field is saved, and the join exits 1.
- **On the old code:** both fields were saved (the test failed there).

The test also covers the http-warning edge cases. The other join unit tests pass: 17/17.
