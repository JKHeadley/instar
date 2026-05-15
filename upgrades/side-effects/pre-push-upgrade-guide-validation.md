# Side-Effects Review — Pre-Push Upgrade-Guide Validation

**Version / slug:** `pre-push-upgrade-guide-validation`
**Date:** `2026-05-15`
**Author:** Echo (instar developer agent)
**Second-pass reviewer:** required (touches a release-gate decision point)

## Summary of the change

Imports `validateGuideContent` from `scripts/upgrade-guide-validator.mjs` (the canonical validator already used by the publish-time `check-upgrade-guide.js`) and runs it inside `scripts/pre-push-gate.js`. Pre-push now rejects the same malformed upgrade-guide shapes that publish rejects, instead of letting them pass push and silently fail publish.

Files touched:
- `scripts/pre-push-gate.js` — adds import, runs `validateGuideContent` on the active guide, surfaces returned issues as errors. Removes the local section-presence + template-placeholder checks (now covered by the validator).
- `tests/unit/pre-push-gate.test.ts` — adjusts the existing scaffolding tests (one shallow content-pattern check replaced with a check that the validator is imported). Adds 4 new integration tests that spawn the actual gate script against fixture NEXT.md files in a scratch directory and assert the right exit code + error message for each of the three publish-blocker shapes plus a well-formed control.

Decision points the change interacts with: only one — the pre-push upgrade-guide gate. The validator is unchanged; this PR just makes pre-push consume it.

## Decision-point inventory

- `scripts/pre-push-gate.js` (push-time deterministic gate over upgrade-guide well-formedness) — **modify** — replaces narrow local rules with a call into the canonical shared validator. Same rules, same authority, now consistently enforced.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

None that wouldn't ALSO be rejected at publish time. The validator's rules are the same ones publishing already enforces — a release notes file that passes pre-push today but is well-formed enough for publish would NOT be newly rejected. A release notes file that is currently passing pre-push but would fail publish IS now rejected at push time. That's the intended over-block fix.

Concrete check: I ran the gate against the live `upgrades/0.28.103.md` (which we cleaned and re-validated earlier today). Local gate reports zero validator-related errors. Other errors surface (e.g., missing side-effects artifact for v0.28.103, a pre-existing issue not introduced by this PR), but those are unrelated to the validator change.

---

## 2. Under-block

**What failure modes does this still miss?**

- **Validator coverage gaps.** Only the rules currently in `validateGuideContent` are enforced — if new publish-blocker patterns emerge that aren't yet in the validator, neither gate catches them. Out of scope for this PR; surfaced as a follow-up to extend the validator rule set together with the next publish-blocker class.
- **Manual side-effects artifact rename at release-cut time.** The existing `## 5 — Side-effects review artifact` block of the gate looks for an artifact filename matching `${version}.md` when the versioned guide is what's being validated. If NEXT.md is renamed to `${version}.md` but the artifact is not renamed to match, the gate rejects. This pre-existing behavior is unchanged by my PR; surfacing it here so a future PR can address.

Neither is a regression introduced by this PR.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. `scripts/pre-push-gate.js` is the canonical home for push-time deterministic gates. `validateGuideContent` is the canonical authority over upgrade-guide well-formedness, shared with `check-upgrade-guide.js` at publish time. This PR is the smallest possible edge that makes the two gates consistent. No new layer; no relocation of existing logic.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [ ] No — this change has no block/allow surface.
- [x] No — this change produces a signal consumed by an existing smart gate.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic.

The validator IS the authority — a deterministic ruleset over a constrained domain (markdown release notes). The pre-push gate is a consumer of that authority. The PR is a refactor that points the consumer at the canonical authority instead of a stale local copy. No new authority introduced; no brittle logic gains blocking power.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing**: the pre-push gate runs validate after section-presence (now collapsed into the same call) and before version-increment, side-effects-artifact, lint-no-direct-destructive, URL.pathname. All other checks unchanged.
- **Double-fire**: the validator runs once at pre-push and once at publish. Pre-push catches malformed guides earlier; publish remains the authoritative final check. Double-fire is the intended design — push-time is a strict subset enforcer of publish-time.
- **Races**: pre-push is single-process synchronous. No race surface.
- **Adjacent cleanups**: existing scaffold tests in `pre-push-gate.test.ts` are adjusted, not removed. The integration tests use temp dirs cleaned up via `SafeFsExecutor.safeRmSync` per the lint-no-direct-destructive rule.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Other agents on the same machine** — no, this is a pre-push gate for the instar source repo. Agents don't push to instar; they only consume releases.
- **Other users of the install base** — no, see above.
- **External systems** — none.
- **Persistent state** — none.
- **Timing / runtime conditions** — the gate now runs validator code at push time. Validator runs synchronously in ~10ms; adds no perceptible latency.

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

- **Hot-fix release**: revert `scripts/pre-push-gate.js` and `tests/unit/pre-push-gate.test.ts`, ship a patch. ~5 minutes.
- **Data migration**: none.
- **Agent state repair**: none.
- **User visibility**: zero. The gate is a developer-facing pre-push check; users see nothing.

---

## Conclusion

Pure scope-tightening of a pre-existing push-time gate to consume a pre-existing publish-time authority. No new decision logic, no new blocking surface, no new persistent state. The motivating incident (yesterday and this morning, multiple PRs stranded on main without reaching npm) is the explicit driver. Worst-case rollback is a two-file revert at ~5 minutes. Clear to ship pending second-pass concurrence.

---

## Second-pass review

**Reviewer:** general-purpose subagent (Echo's review subagent)
**Independent read of the artifact: concur**

The validator-based check is structurally clean: both `pre-push-gate.js` and `check-upgrade-guide.js` import `validateGuideContent` from the same module and feed it `fs.readFileSync(activeGuide, 'utf-8')` — identical input shape, so push-time cannot over-reject relative to publish-time. The validator's REQUIRED_SECTIONS / template-placeholder rules subsume the removed local checks one-for-one; the only other consumer of the old "[Feature name]" / "[Capability]" / section-presence patterns in the gate source was this test file itself, and `tests/unit/upgrade-guide-finalization.test.ts` exercises those strings against the template (unrelated to the gate). Symlink-vs-copy analysis is correct: `lint-no-direct-destructive.js` resolves `ROOT` via `path.resolve(fileURLToPath(import.meta.url), '..', '..')` and Node's ESM loader collapses symlinks before module resolution, so a symlinked copy would scan the production worktree; `fs.copyFileSync` produces a sibling at `scratch/scripts/...` and ROOT correctly resolves to the scratch dir. `SafeFsExecutor.safeRmSync` is called with the correct `{recursive, force, operation}` shape (operation is the required label); scratch lives under `os.tmpdir()` so SourceTreeGuard won't intervene. Integration with the unmodified "Side-effects review artifact" step (gate §5) is consistent — both checks accumulate into the same `errors[]` and fire together. Signal-vs-authority: the validator remains the deterministic authority over a constrained domain (release-notes well-formedness, which falls under the "structural validators at the boundary" carve-out in `docs/signal-vs-authority.md`); the gate is a pure consumer surfacing existing decisions earlier in the workflow.

Minor non-blocking notes (none block the ship):
- `execSync` is imported at line 16 of the test file but no longer used (it was replaced by `spawnSync` on line 33). Dead import; cleanup-only.
- The integration test for the third malformed case ("Fix the misbehavior...") triggers BOTH the missing-Evidence error AND the missing-side-effects-artifact error simultaneously; the assertion on "has no \"## Evidence\" section" still passes because both errors are appended to stdout, but if a future regression flipped the order or the artifact check moved earlier and short-circuited, the assertion might survive without exercising the validator path. Consider an additional fixture that has the side-effects artifact present but the Evidence section missing, to lock in the validator path independently.
- The "ACCEPTS a well-formed NEXT.md" test uses "A small improvement" which doesn't trigger any FIX_PATTERNS — but the test still creates a `test-artifact.md` defensively. Comment in the test claims the gate requires the artifact for "add/new/feature/fix words", but "improvement" matches none of those. The artifact creation is unnecessary belt-and-suspenders, not load-bearing. Not a bug.

---

## Evidence pointers

- Original failed publish runs visible in `gh run list -L 5 --workflow=publish.yml --status=failure` — four consecutive `failure` runs between 2026-05-14 05:00 and 2026-05-15 16:00 before the cleanup PR #228 unblocked publish.
- Test verification: `npx vitest run tests/unit/pre-push-gate.test.ts` → 10/10 passed (4 new integration tests; one scaffold test re-shaped).
- Manual verification: against three handcrafted malformed NEXT.md fixtures, the gate exits non-zero with the right error message; against a well-formed fixture, the gate exits zero.
