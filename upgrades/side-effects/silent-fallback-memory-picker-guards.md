# Side-Effects Review — Memory-picker never-reject guards exempted; silent-fallback baseline 496 -> 494

**Version / slug:** `silent-fallback-memory-picker-guards`
**Date:** `2026-09-30`
**Author:** `Echo`
**Second-pass reviewer:** `not required`

## Summary of the change

After #2102 (jev-memory-picker) merged, `tests/unit/no-silent-fallbacks.test.ts`
reported 496 flagged catches against a baseline of 495, so main was red on it.
Measured with the scanner itself: 494 before the #2102 merge, 496 after, both new
entries in `src/server/routes.ts` — the two `run.catch(() => null)` guards in
`POST /memory-picker/session-context`. The scanner's 20-line forward window
reached `result?.outcome ?? 'fallback'` and counted them.

`JevMemoryPicker.pick()` is documented and built never to reject: every failure
resolves to a result and writes its own log row. The two guards only stop a stray
rejection from becoming unhandled; a `null` in inject mode injects nothing, which
is today's load exactly. This change adds one comment line after each guard
carrying `@silent-fallback-ok` with that reason, and lowers `BASELINE` to the
measured 494.

## Decision-point inventory

- None. Two comment lines and a test constant. No runtime behaviour changes.

---

## 1. Over-block

None — no code path changes.

## 2. Under-block

The ratchet is tighter (494), so it catches one more regression than before.

## 3. Level-of-abstraction fit

Uses the existing in-window exemption convention the scanner defines.

## 4. Signal vs authority compliance

Not a decision point.

## 5. Interactions

The inserted lines shift later `routes.ts` line numbers by two. The full
unit suite (four shards) was run on this tree: green.

## 6. External surfaces

None.

## 7. Rollback cost

Revert the commit; nothing persisted.

## Evidence

- Scanner on `55b0dae2d^1` (main before #2102): 494. On `55b0dae2d` (after): 496,
  per-file diff shows `server/routes.ts` 29 -> 31 (lines 25783, 25787).
- After this change: 494; `no-silent-fallbacks.test.ts` 5/5 pass.
