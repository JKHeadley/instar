# Side-Effects Review — commitment auto-correction holds the config API's write rules

**Version / slug:** `commitment-config-write-authority`
**Date:** `2026-11-17`
**Author:** `Echo (security effort, topic 143781)`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1: 4 source files, 4 test files and 3 docs. Stacked on the reserved-key fix (#3284).

**New `src/config/bearerConfigWrite.ts`** (`bearerConfigWriteRefusal`) states, for a single-path write, the rules `PATCH /config` holds for a bearer caller:
- the same top-level allowlist (`PATCHABLE_CONFIG_KEYS`);
- under `intelligence`, only the governor block, which must be an object, and switching it off needs the PIN;
- never the operator-only session keys (which program a session runs);
- never a reserved object key, in the path or anywhere in the value;
- never a raise of trust or autonomy, judged on exactly what the deep write would produce.

**`CommitmentTracker`** gets `setConfigWriteGuard`. Auto-correction writes only when the guard allows it. Without a guard, on a refusal, or when the guard throws, nothing is written and the drift is reported as a violation. `src/commands/server.ts` wires the guard once the autonomy profile exists. **`LiveConfig.set`** also refuses a value containing a reserved key.

Class of problem: a second config writer acting on a bearer caller's behalf did not hold the config API's authority rules. Reproduced on a throwaway agent: the PIN-gated flood-brake switch and the session program path were written with the API key alone.

## Decision-point inventory

- Commitment auto-correction write — modify — deterministic authority check, mirroring `PATCH /config`.

---

## 1. Over-block

- **Protected settings in commitments:** a promise to keep a setting the API key may not change is still recorded and verified, but its drift is reported rather than corrected automatically. This is unavoidable, because correcting it is exactly the bypass.
- **Remote desktop:** commitments never auto-correct it (stricter than `PATCH /config`'s validated toggle).
- **Startup:** a sweep that runs before the guard is wired (first ~15 seconds) corrects nothing and logs why; the next sweep corrects as normal.

## 2. Under-block

The same as `PATCH /config` itself. The `monitoring` and `jobs` blocks are allowlisted as a whole, so some switches there need no PIN on either route. That is tracked separately for a `PATCH /config` audit.

## 3. Level-of-abstraction fit

- One rule module uses `PATCH /config`'s own key sets.
- The tracker refuses at its single write point.
- `LiveConfig` refuses reserved keys at the write funnel.

## 4. Signal vs authority compliance

- [x] Deterministic authority rule; no content judgment.

## 4b. Judgment-point check

No new heuristic.

## 5. Interactions

- Existing tests that exercise the correction mechanics now set an allow-all guard explicitly.
- The raise check (`configPatchRaises`) sees the deep-set result, so tightening one service is allowed and loosening one is refused.

## 6. External surfaces

None. No route shape change.

## 6b. Operator-surface quality

A refused correction is logged with a plain reason, and the violation surfaces as before.

## 7. Multi-machine posture

Machine-local BY DESIGN: each machine's tracker writes its own config.

## 8. Rollback cost

Revert and ship a patch. No stored data changes.

---

## Conclusion

Closes the reproduced bypass with a single shared rule. The second pass's findings are addressed. Clear to ship.

---

## Second-pass review

**Reviewer:** independent reviewer subagent (Claude, fresh context, read the diff, `PATCH /config` and every `liveConfig.set` caller)

**Independent read: closes the bypass, with concerns, now addressed.** Findings and what was done:
- **Fixed:** a reserved key inside the value passed. It is now refused by the guard and by `LiveConfig.set`.
- **Fixed:** the raise check modelled a whole-block replace, not the deep set that actually happens, which over-refused tightening. It now compares the exact result.
- **Fixed:** a non-object governor value passed. It is now refused.
- **Fixed:** a throwing guard could stop the sweep. It now counts as a refusal.
- **Confirmed:** the guard is wired on the only runtime tracker, and no other `liveConfig.set` caller takes a caller-chosen path.
- **Named in §2:** `monitoring` and `jobs` switches that need no PIN; this is a gap in `PATCH /config` itself, tracked separately.

---

## Evidence pointers

- **Throwaway proof (2026-11-17, private ledger):**
  - With the bearer only, `PATCH /config` refused the flood-brake disable, but a commitment plus a verify sweep wrote it and `sessions.claudePath`.
  - The live governor then read `emergencyDisable = true`.
- `tests/unit/bearer-config-write.test.ts`: 11 tests.
- `tests/unit/CommitmentTracker.test.ts`: new authority tests (no guard, refused, throwing guard, allowed).
- All 8 CommitmentTracker unit files: 55/55.
- Commitments integration + e2e (temporary unit-config copies): 14/14.
- `tsc --noEmit` clean.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable (a code defect in an authority path, closed by the tests above).

## Merge with main (2026-11-17, M5)

The PR's base commit had already merged as #3284. Main was merged in; two server.ts conflicts were additive (imports, and main's organization-pack block next to this PR's config write guard) and keep both sides; the guard still registers at function scope right after the autonomy profile line. Typecheck passes; the four targeted test files pass (107 tests).

**Reviewer:** independent second-pass subagent (fresh context, read-only) — CONCUR; nothing from main or the PR was dropped and the guard runs under the same startup conditions.

## Second merge with main (2026-11-18 00:45 PST, M5)

Main moved again and conflicted in one place: the server.ts import block (this PR's two config-authority imports next to main's new `isOwnersOwnWords` import). All three lines are kept; nothing else conflicted. Typecheck passes; the PR's four test files pass (107 tests).

**Reviewer:** independent read-only subagent (fresh context) — CONCUR; nothing from either side dropped, no duplicate imports, the SEC-075 guard block is unchanged in place and conditions.
