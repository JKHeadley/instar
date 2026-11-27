# Side-Effects Review — owner identities read plainly on "Who can reach me"

**Version / slug:** `reach-owner-keys-plain`
**Date:** `2026-11-20`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier 1, 2 files (~10 lines). `src/users/ReachablePeople.ts` `plainKey` (now exported) renders a `user:` key as "your Instar profile" instead of "Profile <internal id>" in the owner-only "Treated as you" note; other platform keys are unchanged. Found by the 2026-11-20 live dashboard audit (topic 127504). One build pass, first commit attempt.

## Decision-point inventory

No decision-point surface. `operatorKeys` and owner resolution are untouched; only display text changes.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

---

## 2. Under-block

No block/allow surface — under-block not applicable.

---

## 3. Level-of-abstraction fit

Right layer: the one function that words these keys.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

No authority involved.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No decision point.

---

## 5. Interactions

None. The warning string is display-only, read by `/team/people` consumers.

---

## 6. External surfaces

The wording of one owner-only note on the dashboard and in the app's people view.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. **Leads with the primary action?** Unchanged.
2. **Zero raw internals as primary content?** Yes. This removes an internal profile key from the note.
3. **Destructive actions de-emphasized?** Not touched.
4. **Plain language + phone width?** Yes. The note is shorter than before.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Pass-through: computed per read from existing state.

**Status surfaces:** none.

---

## 8. Rollback cost

Revert the commit.

---

## Conclusion

A safe one-function wording fix.

## Second-pass review (if required)

Not required.

## Evidence pointers

- `tests/unit/reachable-people.test.ts`: profile key → "your Instar profile"; phone and Telegram keys unchanged.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
