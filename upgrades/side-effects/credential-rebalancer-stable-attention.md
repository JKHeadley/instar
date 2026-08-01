# Side-Effects Review — Credential rebalancer stable Attention identity

**Version / slug:** `credential-rebalancer-stable-attention`
**Date:** `2026-08-01`
**Author:** `Instar Agent (instar-codey)`
**Second-pass reviewer:** `Gauss (integration review)`

## Summary of the change

The credential-rebalancer policy now attaches a typed condition and affected
slot to its persistent operator notices. The orchestrator preserves those
structured notices, while one canonical helper derives the bounded durable
Attention ID from condition type and a hash of the slot. The server wiring only
forwards that derived ID and the rendered message. This stops a changing
credential-ledger version from creating a new item on every pass. One-off rescue
episode notices retain their previous ledger-version identity. The public status
surface remains string-compatible.

## Decision-point inventory

- `CredentialRebalancerPolicy` notice classification — **modified** — persistent
  states are marked as conditions; the successful default-slot rescue remains a
  one-off episode notice.
- Credential rebalancer Attention identity derivation — **modified** — the
  mechanical idempotency key uses structural condition identity instead of a
  changing ledger version.
- Swap, cooldown, breaker, eligibility, and priority decisions — **pass-through**
  — unchanged.

---

## 1. Over-block

No block/allow surface — over-block is not applicable. The change only determines
whether repeated observations address an existing Attention row.

The identity retains both condition type and slot, so a critical no-target state
does not suppress a noncritical no-target state, and two slots do not suppress
one another.

---

## 2. Under-block

This patch bounds repeated persistent notices from the credential rebalancer on
one machine. It does not provide observe/clear/reopen metadata, update the
existing row's latest text, or repair other Attention identity-minting adapters.
Those class-wide requirements are recorded in feedback `fb-153fcd40-d85`.

Because the current store deduplicates solely by ID, a structurally keyed item
that an operator marks done will not automatically reopen if the condition later
clears and recurs. That is the deliberate limit of this stop-bleeding patch: it
prevents unbounded emission now, while explicit clear/recurrence lifecycle
belongs to the tracked shared condition model. The operator can still reopen the
existing item manually.

The successful default-slot rescue notice intentionally retains its existing
per-ledger-version episode behavior because it describes an actuation episode,
not a persistent condition.

The pool read currently coalesces normal-priority items using a broader source or
category-and-title key. That existing behavior can still collapse distinct
rebalancer conditions in a pool-wide view; it is part of the same tracked
class-wide identity work and is not made worse by this local-store fix.

---

## 3. Level-of-abstraction fit

The policy owns the semantic fact that a notice describes a persistent condition,
because it has the condition type and slot before rendering. The composition root
no longer parses text or invents condition identity. The canonical helper is a
narrow compatibility bridge to the current ID-keyed Attention store. Its input
already has the tuple the future shared condition boundary will consume, so this
patch does not entrench title/summary hashing or wiring-authored identity.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The policy's existing detection and actuation authority are unchanged. ID reuse is
transport idempotency over an explicitly declared condition, one of the principle's
mechanical exceptions; it makes no judgment about whether the condition is valid.

---

## 4b. Judgment-point check

No static heuristic is added at a competing-signals decision point. Condition
type and slot are direct outputs of an enumerable deterministic policy branch.
The slot hash only bounds storage representation and does not influence policy.

---

## 5. Interactions

- **Shadowing:** The existing Attention store still owns exact-ID idempotence.
  This patch supplies it a stable ID; it does not add a parallel dedupe layer.
- **Double-fire:** After deployment, each persistent condition and slot may add
  one new structurally keyed item alongside historical ledger-version items.
  Subsequent passes reuse the new item. Historical rows are not mutated.
- **Races:** Concurrent passes deriving the same ID converge on the existing
  store's ID check. No new mutable state or read-modify-write sequence is added.
- **Feedback loops:** Notice identity does not feed quota readings, eligibility,
  cooldowns, or swap decisions.

---

## 6. External surfaces

The visible change is a quieter operator queue: repeated passes no longer add a
new item and Telegram message for the same rebalancer condition and slot. The
first structurally keyed item remains visible. No new operator action, endpoint,
URL, permission, or external dependency is introduced.

Persistent state remains backward compatible. Existing rows keep their IDs;
the first post-upgrade observation creates the new stable row, and later
observations reuse it.

---

## 6b. Operator-surface quality

No dashboard, form, renderer, or operator action surface is changed. Not
applicable.

---

## 7. Multi-machine posture

**Machine-local by design:** credential slots, local credential assignments, and
their quota readings describe one host. Each host therefore owns its local
condition row. The Attention pool read remains the existing proxied/merged view;
this patch does not introduce replication or a new durable store.

The feature emits user-facing notices. Existing pool-read coalescing and Telegram
routing remain responsible for cross-machine presentation; this patch only bounds
repetition within each owner machine. It holds no topic-transfer state and
generates no URLs.

---

## 8. Rollback cost

Rollback is a code-only patch release. Reverting restores ledger-version IDs.
No data migration or agent-state repair is required. The structurally keyed rows
already written remain ordinary readable Attention items; they do not prevent a
rollback or require deletion.

---

## Conclusion

The review kept the repair at the correct semantic boundary: the policy declares
condition identity, the compatibility helper derives a bounded ID, and wiring
cannot recover identity from rendered text. The change removes the measured
per-pass fan-out without altering rebalancing decisions or queue-wide semantics.
The residual class-wide and pool-view gaps are durably tracked. The independent
second pass found no additional concern.

---

## Second-pass review

**Reviewer:** Gauss
**Independent read of the artifact:** concur

The stable key preserves condition type and affected slot, avoids cross-slot or
cross-type collapse, keeps legacy identity for one-off episodes, and preserves
the public audit/status shape. The review also confirmed that the artifact
accurately discloses pool-view coalescing and the missing clear/reopen lifecycle.

---

## Evidence pointers

- Focused policy, orchestrator, and live credential-route suite: 40 passing.
- Repository lint suite: passing.
- TypeScript build and release-fragment invariants: passing.

---

## Class-Closure Declaration

No agent-authored prompt, hook, config, skill, or standards artifact is fixed.
The rebalancer's cadence, actuation edge, bounds, and settling brakes are unchanged;
only the ID of its existing Attention emission is modified. Self-action
convergence classification is therefore not changed by this patch.
