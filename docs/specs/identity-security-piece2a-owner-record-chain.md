---
title: "The owner record: a signed chain every machine computes the same way"
slug: identity-security-piece2a-owner-record-chain
author: Echo
tier: 2
status: approved
eli16-overview: identity-security-piece2a-owner-record-chain.eli16.md
parent-principle: "Know Your Principal — An Unverified Identity Is a Guess"
sibling-principles: "An Instar Agent Is Always a Multi-Machine Entity; Verify the State, Not Its Symbol; Signal vs. Authority"
parent-spec: "identity-security-levels.md (approved 2026-11-17 19:34 PST, Justin, topic 144636), §12 item 2 (the owner record) and decision 17 (§11), building owner-authentication.md §6"
lessons-engaged: "fix-the-class-not-the-instance, verify-the-state-not-its-symbol, cut-the-sequence-not-just-the-scope"
review-convergence: "2026-11-18T16:04:00Z"
review-iterations: 8
review-completed-at: "2026-11-18T16:04:00Z"
review-report: "reports/identity-security-piece2a-owner-record-chain-convergence.md"
cross-model-review: "codex-cli gpt-6.2-astra (headley.justin) round 1"
approved: true
approved-by: "Under the approved umbrella identity-security-levels.md (Justin, topic 144636, 2026-11-17 19:34 PST: \"great! approved, please enter a 24 hour autonomous session in gpt 6.2 astra to build this\"), §12 item 2, and Justin's standing guidance that only constitution changes need his approval (2026-10-22). No constitution text changes here."
---
# The owner record: a signed chain every machine computes the same way

## Problem statement

Who the owner is, which devices and machines speak for them, and the agent's security level are scattered across machine-local state today:
- `ownerUserId` in config;
- per-host device records;
- a replicated key ledger;
- the PIN.

Nothing proves any of it, and machines can disagree. The approved umbrella (§12 item 2, building owner-authentication §6) replaces this with **one owner record**: a signed chain, replicated over the mesh, that every machine evaluates the same way.

Piece 2 is split like piece 1:
- **2a (this spec)** is the record itself: the entry format, signing, and the one pure function that turns any set of entries into the record's state, the same on every machine and in any order.
- **2b** stores the record beside `identity.json`, bootstraps it at Basic, adopts it over the mesh, makes `everEnrolled` sticky and adds the minimum-build fence.
- **Later pieces** read owner identity and devices from it.

2a has no callers, so it changes no behaviour.

## Proposed design

### 1. Entries

An entry is a JSON object, signed over its canonical JSON (`canonicalJson`, keys sorted) without the signature field:
- `v: 1`;
- `kind`;
- `agentId`: so an entry can never move to another agent;
- `parents`: sorted and unique;
- `body`;
- `signer: { type: 'machine' | 'owner-key', keyId }`;
- `sig`: base64 Ed25519.

An entry's id is the SHA-256 of that canonical JSON.

- **Parents.** A `genesis` has no parent. A `merge` has two or more, the tips it joins. **Every other entry has exactly one parent**, so only a merge can join branches.
- **Key ids are namespaced.** Machine keys are `m_…` (the machine id), owner keys `o_…`. A machine has at most one valid key. An owner key id is never reused.
- **Input is checked before hashing.** An entry that can't be canonicalised (a non-finite number, an `undefined` value) is rejected.

| kind | body | Who may sign it |
| --- | --- | --- |
| `genesis` | `{ machineId, publicKey, level: 'basic', agentProducible: true }` | that machine's own key |
| `add-owner-key` | `{ keyId, publicKey, label, … }` | an owner key. **The first owner key** (none ever existed in the entry's ancestry) is self-signed by the key it adds, and admitted only when the caller's `verifyFirstOwnerProof(body)` accepts the route's proof (umbrella 4.5a; piece 3 supplies the check). With no check supplied, it is refused |
| `add-machine-key` | `{ machineId, publicKey }` | an owner key ("the approval that admits a machine adds its identity key", owner-authentication §6) |
| `revoke-key` | `{ keyId }` | an owner key |
| `policy` | `{ path, value }`; `path: 'level'` sets the level | an owner key; a machine key only while no owner key has ever existed in the entry's ancestry (decision 17) |
| `tls-key` | `{ machineId, fingerprint, seq }` | an owner key, or the machine key of that same machine (owner-authentication §6) |
| `merge` | `{}` | an owner key; a machine key only while no owner key has ever existed (Basic) |

These are the parent specs' powers. The one addition is a machine merge at Basic, which adds no authority because the record is agent-producible then. At Basic, the genesis machine signs only policy, merges and its own TLS key.

### 2. Evaluating the record: one pure function

`evaluateOwnerRecord(entries, { agentId, pinnedGenesis?, verifyFirstOwnerProof? })` returns the record's state from the **full set** of entries, in any order. Every machine computes the same answer from the same set and options.

1. **Parse.**
   - A malformed, wrong-agent, oversized or non-canonical entry is rejected.
   - Every distinct signature over the same content is kept, and the entry counts if **any** of them verifies, so a junk copy can never shadow the real one.
2. **The genesis.** It is the pinned one, else the valid genesis with the lowest machine id (decision 17's tie rule). Others are `not-this-record-genesis`, not fatal. With no valid genesis, the state is `record-invalid`.
3. **Structure versus effect.** Entries are processed parents-first, in a deterministic order.
   - **Hard failures remove an entry, and with it its descendants, from the structure:** unauthorized against the effective state of its own ancestry, or no verifying signature. Junk that anyone can make must not shape the record. Because the effective state reflects the global rules, a key whose adding entry became ineffective authorizes nothing after it. That stays within the mutual-revocation bound, because pass-A revocations are always kept.
   - **Soft failures keep the entry for connectivity, but it doesn't count, and it can never be a tip,** so it can't fork the record or cut away what others built on it. These are the two global rules below, and apply conflicts: a second key for one machine, a reused owner key id, revoking a key that doesn't exist, or revoking one already revoked. An ineffective merge joins nothing; its children start from its first parent's state.
4. **Authority in each entry's own ancestry.** Each entry is folded over its ancestry. A merge's signer is judged on the key instances common to every branch, with every branch's revocations applied.
5. **Two global rules,** judged once against a first pass (pass A), with no iteration. A revocation judged in pass A is never undone.
   - **Machine keys stop when the owner starts.** Once any authentic owner key exists, a machine-signed entry other than its own TLS key counts only if it lies on the path to an owner key.
   - **A revoked key can't keep forking or backdate.** A revoked key instance's non-revocation entries count only when they precede **every** revocation of it, so nothing a stolen key backdates can take effect.
   - **A forced reset is never silent.** No evaluator can tell a thief's revocation from an honest one in general; owner-authentication §6 accepts a forced reset as the limit. An exclusion is **settled** only when at least one revocation causing it was signed by a key still valid at the end. Otherwise the exclusion rests on revoked keys revoking each other, and the record reports `contested` with the entries named. The owner's reset decides, and nothing is downgraded silently. **Callers (2b and later) must not act on `level`, `keys` or `policies` while the record is `contested`.** They hold Sensitive and Serious actions until the reset, as with a missing record. A revoked key can't legitimise what it backdates by supplying its own "earlier" revocation, because the owner's revocation on the main chain rules that out. Revocations themselves always count, so mutual revocation stands: a stolen key that revokes the owner against an old head ends with both revoked, never a takeover.
6. **Revocation targets a key instance,** the entry that added it. A machine re-added with a new key is a new instance, and can publish its TLS key again.
7. **Tips and forks** (owner-authentication §6):
   - The tips are the effective entries that no such entry descends from, leaving out side entries. TLS keys and revocations are side entries: a revocation's effect applies record-wide from pass A, so neither can fork the record, and a revoked key can't keep a fork open with revocations.
   - With one tip, its fold is the record.
   - With several, the common ancestry applies, plus every revocation. Additions and policy on non-common branches are **held** until a `merge` names the tips; `forked: true`.
   - An owner key may merge, and so may a machine key while no owner key exists (Basic, where the record is agent-producible and a merge adds no authority), so a fork at Basic can always be cleared.
   - A held key can be revoked.
8. **TLS keys are side entries.** They never fork the record. Per machine, the effective entry with the highest `seq` wins (ties go to the greater entry id), signed by that machine's key instance still valid in the final state.
9. **Conflicts after a merge.** For a key id or a policy path set on several branches, the value that descends from the other wins. Truly concurrent values tie on the greater entry id. Along one chain, the later entry wins.
10. **The state:**
    - `status`: `ok`, `record-invalid`, `no-valid-key`, `input-too-large`, `owner-lost` (the record was enrolled but no owner key is valid now; machine keys may remain, and only the owner's reset restores human access), or `contested` (see the forced-reset rule above), with the `contested` entries listed;
    - the genesis and head;
    - valid keys with the entry that added each;
    - revoked key ids, level, policies and TLS fingerprints;
    - `everEnrolled` (any authentic owner key was ever added; it never goes back);
    - `agentProducible`;
    - `held`;
    - every rejected or ineffective entry with its reason;
    - `effective`: the entries that took effect, keeping one revocation per (signer key instance, target key instance), plus, for every entry a revocation excludes, one revocation that excludes it (one by a still-valid key if any, else the lowest id);
    - `keep`: `effective` plus the `contested` entries. This is what 2b stores, with their ancestors and one verifying signature per entry (Ed25519 lets one entry carry any number of valid signatures). **A stored copy evaluates to the same state as the full input**: same status, level, keys, revocations, policies and contested set. A test checks this round trip;
    - `rejected` is sorted by (id, reason) with repeats removed, so it is the same for any input order;

### 3. Signing helper

`signOwnerRecordEntry(draft, sign)` sorts the parents, builds the canonical text and calls `sign(text)`, which returns a base64 Ed25519 signature. The same interface serves machine keys (`MachineIdentity.sign`) and owner keys (piece 3's devices).

### 4. Bounds

- **Per entry:** 8 KB of canonical JSON. Every kind is small and fixed-shape.
- **Per evaluation:** 2,000 raw entries. Evaluation is quadratic in entries at worst, and a real record holds tens to hundreds. More is refused whole as `input-too-large`, never partly read.
- **What 2b must do, so the bound is never reached by an attacker:**
  - keep only `effective` entries and their ancestors;
  - cap stored entries per signer key instance per day;
  - treat `input-too-large` as an alarm that keeps the last good state and freezes changes, never as a loss of the record.

  A later piece compacts superseded TLS rotations.
- **No authentic-entry cap,** so a revocation is never refused.

## Decision points touched

- **Authority is checked in each entry's own ancestry, then two global rules apply** (machine keys stop when the owner starts; a revoked key's later entries count for nothing) — invariant; basis: external-constraint; evidence: owner-authentication §6 and umbrella decision 17.
- **The genesis is pinned; without a pin, the lowest machine id's** — invariant; basis: external-constraint; evidence: decision 17's tie rule.
- **The first owner key needs the caller's proof check** — invariant; basis: irreversible-consequence; evidence: umbrella 4.5a.
- **Machine keys sign only their own TLS key, and policy before any owner key** — invariant; basis: external-constraint; evidence: owner-authentication §6 and umbrella decision 17.
- **Revocations always count; additions on a fork are held until a merge** — invariant; basis: irreversible-consequence; evidence: owner-authentication §6 ("This fails safe").
- **Rejected entries are reported, never applied** — invariant; basis: irreversible-consequence; evidence: a record that silently skips entries can't be audited.
- **Bounds** (8 KB per entry; 2,000 raw entries per evaluation; no authentic-entry cap) — judgment-candidate; floor: evaluation stays bounded, a revocation is never refused, junk can't crowd out real entries; arbiter: Echo.

## Multi-machine posture

This is a pure function. Machines agree because they evaluate the same entry set with the same rule; distributing the set is piece 2b.

## Verify the state, not its symbol

| Detector | Symbol | State | Corroboration | Unmeasurable |
| --- | --- | --- | --- | --- |
| Who speaks for the owner | a key id in an entry | that key is valid now | the signature verifies, the signer was valid in the entry's own ancestry, and no counting revocation | a fork without a merge: additions held, revocations applied |

## Rollout

| Stage | What happens | Fallback |
| --- | --- | --- |
| test-agent-live | Not applicable for a library with no callers. Unit tests cover the evaluation with real Ed25519 keys. | — |
| dev-agent-live | Reached with 2b, which stores and adopts the record. | — |
| fleet | Ships as a library; it does nothing until 2b calls it. | Revert. |

## Tests and evidence

- **Unit, with real Ed25519 machine keys and owner keys:**
  - a genesis plus a linear chain;
  - each kind with each signer type, allowed and refused, including machine-key policy before and after the first owner key;
  - a TLS-key entry for another machine, refused;
  - a wrong `agentId`, a bad signature, an unknown parent;
  - two and three genesis entries;
  - a fork with additions held, then merged;
  - revocations counting from a held branch;
  - mutual revocation leading to `no-valid-key`;
  - order independence (every permutation of a small set evaluates to the same state);
  - the caps;
  - `everEnrolled` never resetting.

## Maturation plan

- **ladder:** not applicable: a library with no callers; its behaviour reaches agents with piece 2b
- **test-agent-live:** with 2b.
- **dev-agent-live:** with 2b.
- **fleet:** with 2b.
- **graduation criterion:** green Local Verify, merged commit.
- **dark-window:** none.

## Review rulings (round 1)

- **Constitution check (caps):** revocations can never be refused. The authentic-entry cap is gone, and a raw-input bound replaces it.
- **Internal review, 7 design findings, all applied:**
  - only a merge has several parents;
  - machine keys stop globally when the owner starts;
  - machine-key powers are cut to the parent specs': their own TLS key, and policy at Basic. The first owner key is self-signed with the caller's proof check;
  - the genesis is pinned (else the lowest machine id), and foreign geneses are rejected rather than fatal;
  - a revoked key's later entries count for nothing, and held keys are revocable;
  - deterministic conflicts after a merge;
  - the cap that could kill the record is replaced by an input bound.
- **Precision applied:**
  - rejection carries to descendants;
  - duplicate signatures are handled deterministically;
  - key-id namespaces, and one key per machine;
  - `level` is a policy path;
  - `everEnrolled` comes from any authentic owner key;
  - input is checked before hashing;
  - one signing interface.

- **Delta review (5 design), all applied, each now a regression test:**
  - **A stolen key took over.** Fixed by splitting structure from effect: the second pass no longer cuts out descendants, so the outcome is mutual revocation.
  - **The second pass wasn't settled.** It is now one fixed definition against pass A, and revocations are never undone.
  - **A junk copy could shadow an entry.** Fixed: any verifying signature counts.
  - **A TLS key forked the record.** TLS keys are now side entries, and a machine merge is allowed at Basic.
  - **A re-added machine couldn't publish its TLS key.** Revocation now targets a key instance.

- **Cross-model round 1:**
  - **Applied:** the genesis is anchored by the caller's pin (2b's trusted bootstrap context); the first owner key needs its own signature and the route proof; `owner-lost` covers losing the last owner key while machine keys remain; the caps are replaced.
  - **Ruled to other pieces:** piece-1 acceptance and the other piece-1 items (1a to 1h, already built); the activation evidence (two-machine adoption, partition, below-build refusal) belongs to 2b.

- **Second delta (2 design):**
  - **Applied:** revocations are side entries, so a revoked key can't fork the record with them. Revoking a key that doesn't exist does nothing and is never stored.
  - **Ruled to 2b, with explicit requirements:** the input bound can't be exhausted by an attacker. 2b stores only effective entries and their ancestors, caps stored entries per signer per day, and keeps the last good state on an over-bound input.
  - **Precision:** the merge leak is fixed, and the hard-failure wording is corrected.

- **Third delta (2 design), applied:**
  - A revoked key's entries must precede **every** revocation of it; this is probe G, now a regression test.
  - Re-revoking an already-revoked key does nothing and is never kept, and `effective` keeps one revocation per signer and target pair; this is probe E.
  - Precision: 2b keeps one verifying signature per entry.

- **Fourth delta (1 design), applied:** a key's own line of descent is left out of the every-revocation check; this is probe H, a silent downgrade, now a regression test.

- **Fifth delta (1 design: probe I):** the own-line exclusion also dropped honest revocations by devices the first owner key added, which re-opened a takeover. Rather than refine the rule again, the design returns to the strict rule (no takeover: probes G and I) and makes the one ambiguous case visible as `contested` (probe H), following owner-authentication §6's accepted limit. Each probe is a regression test.

- **Sixth delta (1 design: probe J):** a revoked key outside the honest key's line could still downgrade silently. Applied the reviewer's general rule: an exclusion is settled only if a causing revocation was signed by a key still valid at the end, else `contested`. It covers G, H, I and J, and an honest revocation by a valid key stays `ok`. Precision: callers hold while `contested`.

- **Code second pass (3 defects), applied:** no `String()` on sender-controlled values (a bad `toString` could crash the evaluation); storage now keeps an excluding revocation for every exclusion plus the contested entries (`keep`), so the stored copy reproduces the full result; `rejected` is sorted and deduplicated. Each is a regression test.

## Open questions

*(none)*

## Left behind

- Storage, bootstrap at Basic, mesh adoption, the `everEnrolled` stickiness in each machine's signed state, and the minimum-build fence (2b).
- Device keys from phones and security keys (piece 3).
- The owner's reset when no valid key remains.
