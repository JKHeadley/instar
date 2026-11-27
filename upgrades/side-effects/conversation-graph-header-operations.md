# Side-Effects Review — effort header operations (erasable titles, certified-only application)

**Version / slug:** `conversation-graph-header-operations`
**Date:** `2026-11-05`
**Author:** `Dawn (claude-code), effort-header owner for Echo's Conversations run`
**Second-pass reviewer:** `independent verifier (claude-code subagent)`

## Summary of the change

Three parts, all unwired (nothing in `src/` imports these modules outside their tests):

1. **Effort headers to v3 §7.6, metadata only.** `src/core/EffortHeaderStore.ts` (first landed in a5190cf2b as a local plaintext file) becomes the store of header METADATA under the custody decision taken with the runtime owner on 2026-11-05 (Echo topic 137342): the runtime's witness/replication owns the one encrypted payload and key lifecycle and its backup/erasure protocol, so this store holds no title, salt, key or ciphertext — only, per header, the applied operations' cores (opId, kind, base version, operation hash, salted commitment, bundle reference) and a forgotten flag. A header is addressed by an opaque random `headerId` (`hdr-…`), which `create-effort` now requires. `HeaderOperation` = `set-effort-title` (salted `titleCommitment` + `bundleRef`; never plaintext, never an unsalted hash) or `forget-header`, owner-only, identifier-only fields. `applyCertified(op, {title, salt})` verifies the decrypted pair against the commitment, then persists only metadata. `titleOf(headerId)` resolves through an injected `HeaderDecryptor` over the runtime's certified custody and re-verifies the answer against the winning commitment; missing, erased or mismatching custody reads as null; nothing is cached. A forget is a single write that suppresses serving at once. Derivation is order-independent (same-base races by smallest op hash, reported; future bases held; forgotten version = max(forget base)+1; refused operations never recorded); every read and write re-checks the file.
2. **Correction support for increment C.** `reduceGraph` exposes `placementHeads` / `frontDoorHeads` (every current head per subject, both sides of an owner conflict). `moveEligibility(events, opts, subject, parent)` appends a hypothetical owner placement naming those heads and runs the real reducer, reporting what it did (relation-invalid / would-create-cycle / front-door-held) — no second set of rules. An owner may therefore correct a wrongly inferred placement even when the move only cycles through a lower-tier edge, exactly as the reducer allows.
3. **Provenance on projection items (v3 §5.1).** `ProjectionItem.placedBy` — the authority (`owner` / `delegation` / `import` / `inference`) of the placement that actually holds the node under its parent, including after a conflict, front-door guard or cycle fallback — so "Why here?" can be answered and an inferred placement is never presented as accepted. Absent for roots; conflicts are reported separately. Also: event and header-operation timestamps must have exactly millisecond precision (string order = time order, which the reducer relies on), and `moveEligibility` takes the createdAt the real correction will carry and uses a probe id the validator rejects.
4. `src/core/conversationGraphRead.ts`: doc comment only (effortTitle resolves via headerId). The held read-model contract fixes are NOT in this change (the runtime owner is landing them with a signed cursor).

Spec: `docs/specs/conversation-effort-hierarchy-v3.md` §3.2, §3.3, §7.6. Tests: `EffortHeaderStore.test.ts` (14), `conversation-graph.test.ts` (49), plus the read and store suites — 83 in all. Tier 2.

## Decision-point inventory

- `validateHeaderOperation` — **add** — schema, exact keys (a plaintext `title` field is refused), owner-only authority.
- `applyCertified` — **add** — duplicate / opid-conflict / forgotten / commitment-mismatch / invalid / title-required refusals; refused sets are never recorded.
- `moveEligibility` — **add** — a read-only answer for the correction service, computed by the reducer itself; the reducer stays the authority at certification time.
- `create-effort` — **modify** — requires an opaque `headerId`.
- Identifier fields — **modify (also in GraphEvent)** — `principal`, `machineId`, receipt and bundle ids, and project-scope ids must match `^[A-Za-z0-9_.:@-]{1,120}$`, so prose cannot ride in an immutable core.
- Derived title — **add** — version chain by baseVersion, race resolution by op hash, held future versions.

---

## 1. Over-block

- A set that arrives after a forget is refused permanently, even if the owner later wants a new title for the same effort. Intended (§7.6: later versions cannot restore erased text); a new title needs a new effort.
- A title whose canonical form (NFC, trimmed) is empty or over 200 characters is refused.

## 2. Under-block

- Certification is the runtime's: a caller that passes an uncertified operation, or a title it did not decrypt from the bundle, is believed as long as the commitment matches. The commitment check stops a wrong title, not a premature one.
- The commitment is permanent in the immutable core; its secrecy after erasure rests on the salt being destroyed with the bundle and every dependent copy, which is the runtime's erasure duty.
- `moveEligibility` is a snapshot answer: a move that is eligible now can still be refused if the graph changes before it is certified. It reduces the event set twice per call. It does not check project-scope compatibility (§3.3), which the correction service must add, and it accepts a parent effort the graph has not seen, because the reducer does.
- Erasure here is local: other members, the witness and the encrypted bundles are purged by the runtime; the store reports `local: true`.
- Losing operations from a same-version race keep only their metadata (commitment, bundle reference); their text stays in the runtime's custody until erased there. A reused opId with different content resolves to the smaller operation hash on every member.
- ONE writer per stateDir is required. `applyCertified` re-reads the file before every write and every read re-checks it, so a sequential second writer cannot resurrect erased text and a reader cannot serve it from memory (both tested), but there is no lock: two processes writing at the same instant can still lose an update.
- Erasure of the text itself (bundles, keys, every version, member, stage and backup) is entirely the runtime's §7.6 duty; this store's part is the tombstone that stops serving and refuses later sets.
- `titleOf` trusts the injected decryptor to read only all-member-certified custody and not to cache plaintext; it re-checks the commitment, which stops wrong text but not premature text.
- Identifier-shaped fields still accept a short no-space token (e.g. `Acme_merger`); the rule stops prose, not every possible label. They are identifiers by contract.

## 3. Level-of-abstraction fit

Right layer: certification, decryption and text custody belong to the runtime that holds replication and keys; this store holds only the operation metadata and the deterministic derivation, which every member must compute identically.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface on any live path.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment point: race resolution is deterministic by design so every member converges; the owner resolves a reported race by writing again.

## 4c. Spec reconciliation

v3 §3.2's operation table says header changes are a "versioned `EffortHeaderStore` write … explicit compare-and-set; no last-writer guess" and names `forget-header`. This design keeps both properties and refines the mechanism: a set names its base version (compare-and-set); two CERTIFIED sets on one base version are resolved by smallest operation hash on every member and reported as a conflict for the owner, never by arrival or clock. The operation is named `forget-header` as in v3. The runtime's change API still returns `409 header-version-conflict` to a client writing a stale version, so the client-facing behaviour is the table's.

## 5. Interactions

Replaces the unwired local API from a5190cf2b; nothing called it. `GraphProjection` consumes `titleOf` as before. `SafeFsExecutor` handles both unlinks.

## 6. External surfaces

None until wired. The operation shape is the contract the runtime intake, witness and replication workers build against.

## 6b. Operator-surface quality

Not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Posture: unified by construction, applied locally.** The store holds no keys or text; the runtime's custody does. The store only materializes operations the runtime has certified on every installed member, and its derivation is order-independent, so every member that has applied the same operations shows the same title. Replication and certification are the runtime's (Echo topic 137342). The header file is `schemaVersion: 4`; any older file (written only by tests of the unwired earlier API) is refused, not silently replaced.

**Status surfaces:** none added or changed.

## 8. Rollback cost

Revert the commit. Unwired; no production file exists.

## Conclusion

Header text never enters this store or any graph event: it stays in the runtime's custody, is checked against a salted commitment when it is applied and again when it is served, and a forget stops serving at once.

## Second-pass review

**Reviewer:** independent-verifier (Claude Code subagent, fresh context, 2026-11-05)
**Independent read of the artifact: concur**

A first fresh reviewer examined the encrypted-at-rest version and found `moveEligibility` refusing owner corrections that only cycled through agent edges and a `parent-unknown` rule the reducer lacks; that version was then superseded by the runtime owner's custody decision (metadata-only). A second fresh reviewer, four rounds: (1) mixed-precision timestamps mis-ordered (in the reducer too), a future-dated event and a collidable probe id skewing `moveEligibility`, a catch-all cycle label, `placedBy` mislabelling guard/cycle fallbacks (one as agreed when inference held it), order-dependent reused opIds, stale artifact lines; (2) a set reusing a forget's opId could resurrect erased text, and a flaky test; (3) a forget reusing a set's opId was refused when the set arrived first. All fixed with regressions. Round 4, after 80 probes in both orders: "Concur with the review".

## Class-Closure Declaration

- **Defect class:** `unbounded-self-action`
- **Closure:** `n/a` (negative declaration)
- **Reason:** No self-triggered action: a store applied by a caller; no timer, loop, retry, restart, spawn or notification.

## Evidence pointers

- `npx vitest run tests/unit/EffortHeaderStore.test.ts` → 14 passed (83 across the four conversation-graph test files).
- `npx tsc --noEmit -p .` → exit 0.
