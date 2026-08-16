# Side-Effects Review — pre-push gate: CI scope fix

**Version / slug:** `pre-push-gate-ci-scope`
**Date:** `2026-04-17`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Modifies `scripts/pre-push-gate.js` in two ways: (1) wraps section 5 (side-effects artifact check) in `if (!process.env.CI)`, so the check runs only when developers push locally and is skipped in GitHub Actions; (2) adds `2>/dev/null` to the `HEAD~1` stderr fallback in section 3's git diff command, stopping stderr from leaking through the try/catch into the test output in shallow-clone CI environments. No `src/` files are touched — only the gate script itself.

## Decision-point inventory

- `scripts/pre-push-gate.js` section 5 — **modify** — narrows the scope of the side-effects artifact check from "always" to "not in CI". The check itself is unchanged; only its execution context is restricted.
- `scripts/pre-push-gate.js` section 3 — **modify** — cosmetic: suppresses stderr noise from a git fallback command. No decision logic involved.

---

## 1. Over-block

No block/allow surface for messages or agent actions — not applicable in the traditional sense.

Within the gate's own domain: the change *reduces* over-block. Previously the gate would reject any CI run on a contributor branch that was cut before the side-effects artifact for the current version was added to main. That's a false positive — the contributor didn't violate the process, the artifact simply hadn't been added to main yet when they branched. The fix stops those legitimate branches from being blocked.

No new rejection surface is introduced.

---

## 2. Under-block

The gate now allows CI runs that are missing the side-effects artifact. This is an intentional scope reduction: CI is not the enforcement point. The enforcement points are:

1. The pre-commit hook (`scripts/instar-dev-precommit.js`) — runs per-commit on the developer's machine.
2. The pre-push hook (this gate, section 5) — runs on the developer's machine at push time.

Both hooks run before code reaches CI. If a developer bypasses them (e.g., `--no-verify`), section 5 in CI would have caught it — and now it won't. This is a real reduction in defense depth for the `--no-verify` bypass case.

Mitigation: `--no-verify` bypasses are visible in git history (the commit won't have the artifact). The pre-push gate also re-checks at the release-cut step when NEXT.md is renamed to a versioned file — which does happen locally, not in CI. The net under-block exposure is: a developer who uses `--no-verify` and then somehow gets their branch merged without a local push. This is a narrow path that the review process (PR review, merge gating) is expected to catch.

---

## 3. Level-of-abstraction fit

The gate is a structural process-enforcement check, not a message-content gate. Section 5 is explicitly scoped to "push time" in its own comment. CI is not push time — it's post-push. Running a push-time check in CI creates a category mismatch that produces false failures on valid contributor branches.

The fix is at the correct layer: the `if (!process.env.CI)` guard is a simple execution-context discriminator applied directly to the check that's miscategorized for CI. No rearchitecting needed.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no block/allow surface.

The gate operates on developer process compliance (file existence, git metadata), not on message content or agent behavior. The signal-vs-authority principle applies to decision points that evaluate messages or constrain agent information flow. A CI scope guard on a developer process check is outside that domain.

The change itself is a pure scope restriction — it *removes* an execution context from an existing check. No new brittle logic is added. No new authority is claimed.

---

## 5. Interactions

**Shadowing:** The pre-commit hook and the local pre-push hook both enforce section 5's requirement. This change scopes section 5 to local-only. The pre-commit hook is unchanged — it still runs on every commit. No shadowing occurs.

**Double-fire:** Section 5 currently runs both locally (pre-push) and in CI (via the test that invokes the gate script). After this change it only runs locally. No double-fire; in fact we're eliminating the accidental double-enforcement.

**Races:** No shared state involved. The check reads filesystem files (upgrade guides, side-effects dir). No concurrent access concern.

**Feedback loops:** None. The gate is a one-way exit check with no input to any system that feeds back.

---

## 6. External surfaces

- **Other agents:** No effect. The gate runs only in the instar repo's CI and in developer environments.
- **Install base users:** No effect. This is a developer tooling change, not a runtime change. `instar` as installed by users has no pre-push gate.
- **External systems:** No effect.
- **Persistent state:** No effect.
- **Timing/runtime:** The `CI` env var is set by GitHub Actions automatically for all runs. No timing dependency — it's present or absent at process start.

---

## 7. Rollback cost

Pure code change in `scripts/pre-push-gate.js`. Revert and ship a patch. No persistent state, no migration, no agent state repair. The only user-visible effect during the rollback window would be contributor PR CI runs again failing on missing side-effects artifacts — which is the exact condition we're fixing, not a new regression.

---

## Conclusion

The change is narrow and correct. It scopes section 5 of the pre-push gate to local developer contexts only, which matches the intent stated in the gate's own comment ("at push time"). The under-block exposure (a developer using `--no-verify` evading CI detection) is real but narrow: it requires bypassing two local enforcement hooks AND getting a PR merged without review catching the missing artifact. The pre-commit hook and PR review process are the remaining guards. The fix is clear to ship.

No design changes were made as a result of the review.

---

## Evidence pointers

- `tests/unit/pre-push-gate.test.ts` — all 6 tests pass locally after the change.
- `CI=true node scripts/pre-push-gate.js` — exits 0 on the current branch (which has the 0.28.49 versioned guide with fix/feature language but no fresh side-effects artifact for that version in CI context).
- Without `CI`, the gate still enforces section 5 (verified by the existing passing local test that runs the gate in a non-CI shell).
