# Side-Effects Review — config writes refuse JavaScript object-machinery keys

**Version / slug:** `config-patch-reserved-keys`
**Date:** `2026-11-17`
**Author:** `Echo (security effort, topic 143781)`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1: 6 source files, 2 test files and 3 docs.

- **`PATCH /config`** (`src/server/routes.ts`) refuses with a 400 any patch that has a key named `__proto__`, `prototype` or `constructor` at any depth. The check uses a new `findReservedObjectKey` and runs before anything reads or merges the patch. The route's `selfActionGovernor` deep merge also skips those keys and follows only own properties.
- **`LiveConfig`** refuses a `set` whose path has a reserved segment. Reads follow own properties only, and never a reserved or inherited name.
- **The other deep merges** (config defaults, guard posture, dispatched config merges, secret migration) skip reserved keys.

Class of problem: a JSON body keeps an own `__proto__` key, and a merge or path walk that follows it writes onto every object in the process. Here that included a route past the PIN check on the flood-brake switch. Found by the standing security review and reproduced on a throwaway.

## Decision-point inventory

- Config patch validation — add — deterministic refusal of reserved key names.
- LiveConfig path validation — add — same rule.

---

## 1. Over-block

A config key literally named `__proto__`, `prototype` or `constructor` is refused. No real setting uses these names. A user-named map entry, such as a job or service, with one of those names would now get a 400, which is acceptable.

## 2. Under-block

- A different config writer, the commitment auto-correction, writes any config path with only the bearer. It is closed for pollution here (`LiveConfig` refuses reserved paths), but its broader authority bypass is a separate finding with its own fix (SEC-075).
- Per-class `selfActionGovernor` relaxations are bearer-patchable without a PIN. This predates the change and is folded into SEC-075.

## 3. Level-of-abstraction fit

- The route refuses at the edge.
- `LiveConfig` and the merge helpers refuse at the write funnels, closing the class rather than the one route.

## 4. Signal vs authority compliance

- [x] Deterministic identifier invariant; no content judgment.

## 4b. Judgment-point check

No new heuristic.

## 5. Interactions

- **LiveConfig reads:** the own-properties-only change makes no difference for parsed JSON config. Inherited names were never settings.
- **Commitment auto-correction:** a refused path throws inside its existing `try` and is recorded as a failed correction.

## 6. External surfaces

`PATCH /config` can answer 400 with `"<path>" is not a valid config key`.

## 6b. Operator-surface quality

The 400 names the offending path plainly.

## 7. Multi-machine posture

Machine-local BY DESIGN: input validation on each machine's own config writes.

## 8. Rollback cost

Revert and ship a patch. No stored data changes.

---

## Conclusion

Closes prototype pollution through config writes at every merge and path funnel found. The second pass agrees on the route fix; the broader write-authority gap it found is tracked as SEC-075. Clear to ship.

---

## Second-pass review

**Reviewer:** independent reviewer subagent (Claude, fresh context, read the diff and every config write path)

**Independent read: correct for `PATCH /config` (the PIN check is sound there, and no legitimate caller is broken). Concerns elsewhere.**

- **Commitments path, partly fixed here:** the commitments route can write any config path through `LiveConfig`, including reserved paths (pollution) and PIN-gated values.
  - The pollution part is fixed here with the `LiveConfig` guard.
  - The authority part becomes SEC-075, with its own fix.
- **Governor class relaxations:** bearer-patchable and pre-existing; folded into SEC-075.
- **Test gaps, closed:** the wiring check only searched source text. A behavioural `LiveConfig` test now exercises the guard.

---

## Evidence pointers

- `tests/integration/self-action-governor-route.test.ts`: the new reserved-key case fails on the previous code (200 plus pollution) and passes now. 11/11, run as a temporary unit-config copy.
- `tests/unit/reserved-object-keys.test.ts`: 4 tests, including the behavioural `LiveConfig` refusal.
- LiveConfig and commitment-tracker unit files: 83/83 and 36/36.
- `tsc --noEmit` clean.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable (a code defect in config merges, closed by the tests above).
