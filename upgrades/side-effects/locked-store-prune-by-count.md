# Side-Effects Review — Locked-Mac duty store prunes by count

**Version / slug:** `locked-store-prune-by-count`
**Date:** `2026-11-09`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier 1: 2 code files (`src/native/remote-desktop/macos/InstarDesktopHost.swift` about +27/-6, `tests/unit/desktop-helper-state-op.test.ts` +26), plus ELI16, this artifact and a release fragment. Effort: no spec rounds, one build pass. The helper's `pruneOld()` (run on every `marker-create`) now drops finished, already-reported duty records past the newest 30 as well as those older than 7 days; the selection lives in a new `prunableKeys()`. The `read` op applies the same selection to the copy it returns, so a store that is already oversized reads correctly at once without the read writing anything. Fixes fb-3a84590d-1e8: after ~126 finished duties in a week the read reply crossed `MacDesktopHost.ts`'s 64,000-byte state-op limit and `/desktop/locked/status` answered 503 `mac-desktop-host-output-limit`, making the Mac's locked path unusable for up to a week.

## Decision-point inventory

- Store retention (`pruneOld`/`prunableKeys` in the helper) — modify — which finished records are kept. Not a gate on agent behaviour or information flow; a data-retention rule.
- Node's 64,000-byte state-op read limit (`MacDesktopHost.run`) — pass-through — unchanged.

---

## 1. Over-block

No block/allow surface — over-block not applicable. Retention side: a finished record the operator might want to look back at past the newest 30 is no longer kept on the Mac. Node never reads finished records except the current duty (`DesktopLockedController`: open duties, `relock-failed` counts, the current key's `enterPendingAt`), and the current duty is always the newest. Audit history lives in the server's desktop audit log, not this store.

---

## 2. Under-block

No block/allow surface. Remaining growth path: owed duties and unreported `relock-failed` records are never pruned, so thousands of unreported failures could still grow the store. Those are reported (and marked) by the server's sweep within seconds, so a pile-up needs the server itself broken; then the 503 is the right signal that something is wrong.

---

## 3. Level-of-abstraction fit

Right layer: the helper owns the store and its lock, and already ran age pruning at `marker-create`. Raising Node's read limit instead would leave the store unbounded within the week. Trimming in `read` (copy only) handles stores already past the limit without giving a read path write authority.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

Retention of a private store; nothing is blocked or allowed by it.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. "Keep newest 30 finished" is a size bound on a data store, an enumerable invariant; it never decides anything for the agent.

---

## 5. Interactions

- Relock guard / watch / sweep: they key on open duties and `relock-failed`+unreported, both always kept.
- `mark-reported` then prune: a reported failure becomes prunable like any finished record. Intended (same as the age rule before).
- Ordering ties: sorted by `createdAt` then key, deterministic.
- Concurrency: pruning still runs inside `withLock`; the read trim works on a local copy. No new race.

---

## 6. External surfaces

No route, payload shape or message changes. `/desktop/locked/status` returns 200 instead of 503 on an oversized store. The helper's source hash changes, so, as with every helper change, a Mac keeps using its granted installed copy until the new copy is granted (existing `MacDesktopHost` grant hand-over).

---

## 6b. Operator-surface quality

No operator surface touched — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN: the store records whether this Mac's own screen owes a relock; another machine has no lock screen to guard here. No new status surfaces, notices or URLs.

---

## 8. Rollback cost

Revert the commit and release. Records already pruned are finished history nothing reads; no data migration or agent repair needed.

---

## Conclusion

Safe Tier-1 availability fix in the helper that owns the store, tested against the real built helper. Clear to ship.

## Second-pass review (if required)

Not required: no gate, sentinel, session lifecycle or messaging decision touched.

## Evidence pointers

- `tests/unit/desktop-helper-state-op.test.ts` — "stays readable with 200 finished duties: the read trims, the next create prunes (fb-3a84590d-1e8)", passes against the built helper (`INSTAR_REAL_DESKTOP_HELPER_TESTS=1`, macOS 26).
- Same file, "reads the secure-input owner from IOResources", fails in this run because the build machine's console belongs to another user (`instarproof`), so the helper's probe returns no `lockInputs` here. This change does not touch probe code. It passes on a machine where the running user is on the console.
- fb-3a84590d-1e8 measurements: 126 records = 63,351 bytes (read worked), 127 = 63,873 bytes plus wrapper (503).

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect, and no self-triggered controller added or changed — not applicable.
