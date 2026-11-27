# Side-Effects Review — Secret store key-path hardening

**Version / slug:** `secret-key-path-hardening`
**Date:** `2026-11-15`
**Author:** `Echo (security-review job, pass 2)`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1, 4 files (1 source, 1 test, 2 docs), about 90 lines; one spec-free review round, first commit attempt. `src/core/SecretStore.ts`: the three private dotted-path helpers behind `SecretStore.get/set/delete` now (a) refuse any key path that contains `__proto__`, `prototype` or `constructor` as a whole segment (set throws `secret-key-path-reserved-segment`, get returns `undefined`, delete is a no-op), (b) follow only the vault's own properties (`hasOwnProperty`), never inherited ones, and (c) treat a `null` intermediate like any non-object (replace it on set) instead of throwing. One small exported predicate, `hasReservedKeySegment`, is added for callers that want to check a name first. Class of problem: prototype-reserved segments in caller-supplied dotted key paths. Found by the standing security review; triaged hardening (reaching it needs an already highly trusted caller). The user-visible effect is none.

## Decision-point inventory

- `SecretStore.set` key-path validation — add — refuses a reserved segment (structural invariant on identifiers, not a content judgment).
- `SecretStore.get` / `delete` traversal — modify — own-property traversal; reserved names read as absent.

---

## 1. Over-block

A secret whose name has a segment exactly equal to `__proto__`, `prototype` or `constructor` can no longer be written. A search of every `get/set/delete` call with a literal key in `src/` found none, and secret names are chosen by Instar's own code (feature names, account names, drop tokens). Names that merely contain the word (`prototypes.constructorKey`) are unaffected and covered by a test. A vault that somehow already held such a key would read it as absent; the vault is written only through `set`/`write`, and `set` could never have stored a value under `__proto__` (it went to the prototype, not the data), so no real data is hidden. `write()` of a whole object is unchanged.

## 2. Under-block

Only the three names that reach JavaScript's object machinery are refused; other odd names (empty segments, very long names) behave as before, which is correct since they address ordinary data. Callers that build their own nested objects outside these helpers are not covered by this change; none was found reaching the store's data with a caller-chosen key.

## 3. Level-of-abstraction fit

Right layer: the store's own path helpers are the single funnel every get/set/delete goes through, so fixing it there covers every caller (HTTP, mesh sync, setup flows) at once rather than validating at each call site.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface over messages or actions. It is a deterministic invariant on identifiers inside a data store (the same kind as refusing `..` in a file path), which Signal vs Authority allows to hold authority: the domain is enumerable and the check is not a content judgment.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The reserved set is an enumerable language invariant.

## 5. Interactions

- **Shadowing:** `SecretSync`'s receive handler calls `store.set` per key; a batch containing a reserved name now throws at that key, as any store error already did. Keys earlier in that batch stay stored and the rest of the batch is skipped (a partial apply, the same as any other store error there). No legitimate sender produces such a name, and the batch comes from an authenticated paired machine.
- **Double-fire / races / feedback loops:** none; the helpers are pure functions over the decrypted object, called inside the existing read-modify-write.

## 6. External surfaces

No external surface changes. No API shape, route, config key or file format changes. No operator-facing actions.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Machine-local BY DESIGN: this is validation inside each machine's own store; secret sync between machines already goes through `store.set` on the receiving side, so every machine applies the same rule to what it stores. No notices, no durable new state, no URLs. Status surfaces: none changed.

## 8. Rollback cost

Pure code change: revert and ship a patch. No persistent state changes, no migration, no user-visible regression during rollback.

---

## Conclusion

Small, contained hardening at the single funnel for secret key paths, with tests that fail on the old code and pass on the new. Clear to ship.

---

## Second-pass review

**Reviewer:** independent reviewer subagent (Claude, fresh context, read the diff before the artifact)
**Independent read of the artifact: concur**

No remaining way found for a caller-chosen dotted path to write onto a shared prototype (every segment including the last is checked; traversal uses own properties only, safe for null-prototype objects; arrays, empty segments and JSON-parsed own `"__proto__"` keys handled). No existing caller broken (machine-recovery prefixes, validated drop tokens, sync keys, email-shaped names). One wording gap, now fixed above: the partial apply of a sync batch that hits a reserved name.

---

## Evidence pointers

`tests/unit/secret-store.test.ts` → `reserved key-path segments` (8 tests; 6 fail on the old code). 93/93 across secret-store, global-secret-store, secret-store-durability, secret-store-key-coherence, secret-sync-graph-local. `tsc --noEmit` clean.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable (a code defect in a data-store helper, closed by the unit tests above).
