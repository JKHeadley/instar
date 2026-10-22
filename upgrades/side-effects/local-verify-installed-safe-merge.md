# Side-Effects Review — local-verify status loop loads the installed safe-merge

**Version / slug:** `local-verify-installed-safe-merge`
**Date:** `2026-10-22`
**Author:** `Echo`
**Second-pass reviewer:** `not required (one import path in a feature that is off by default; no merge-path change)`

## Summary of the change

`loadSafeMergeFloor` (src/localVerify/localVerifyWiring.ts) imported `scripts/safe-merge.mjs` from the server's working directory, the agent-home checkout. On the first enable after release (2026-10-22) that checkout sat on an old branch with a pre-local-verify safe-merge, so the status loop was never built ("no safe-merge floor"). It now loads `<package>/scripts/safe-merge.mjs` from the running server's own install (`installedSafeMergePath()`), as the spec requires for the verifier's trusted side. Files: `src/localVerify/localVerifyWiring.ts`, `tests/e2e/local-verify-lifecycle.test.ts`.

## Decision-point inventory

No decision-point change: which file the existing evaluation function is loaded from.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

---

## 2. Under-block

No block/allow surface — under-block not applicable. Not changed here, and tracked as **ACT-150**: the green-PR watcher and MergeRunner still spawn the checkout's safe-merge; that must move to the installed copy before the local floor is switched on.

---

## 3. Level-of-abstraction fit

Matches `installedMainEntry()`: both resolve next to the running module, so the trusted code is always the installed release.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point.

---

## 5. Interactions

The npm package already ships `scripts/safe-merge.mjs` (checked in the installed 1.3.1392). In a source checkout running from `dist/` (or tests running from `src/`) the path resolves to the repo's own `scripts/`.

---

## 6. External surfaces

None. With `postStatuses` false (the default) the status loop posts nothing.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

Not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Each machine loads its own installed copy; unchanged.

---

## 8. Rollback cost

Revert the commit.

---

## Conclusion

One-line fix so the status loop uses the installed safe-merge; the watcher's equivalent is tracked for before the flip.

## Second-pass review (if required)

Not required.

## Evidence pointers

- `tests/e2e/local-verify-lifecycle.test.ts` (installed path resolves to the package's `scripts/`; a stale checkout safe-merge is never consulted; the loop builds)
