# Side-Effects Review — pre-push gate accepts release cut commits; §3b counts only added/modified fragments

**Version / slug:** `release-cut-push-gate`
**Date:** `2026-10-20`
**Author:** `Dawn`
**Second-pass reviewer:** `Echo (PR review round 1 at cbb49d5c2; re-review of this head pending)`

## Summary of the change

`scripts/pre-push-gate.js` §3b (release-relevant change with no release-note fragment) gets two changes. (1) It exempts a release CUT, decided by the new pure module `scripts/release-cut-diff.mjs` (`classifyReleaseCut`, plus `detectReleaseCut` for the git I/O). A diff is a cut only when, with rename detection off, every entry is: `M package.json` whose parsed JSON differs from the merge-base only in `version`, and the version INCREASES (numeric X.Y.Z compare) (required); optionally `M package-lock.json` whose parsed JSON differs only in top-level `version` and `packages[""].version`, both equal to the new version; exactly one `A upgrades/<new X.Y.Z>.md` (required); and any number of `D upgrades/next/*.md` / `D upgrades/NEXT.md`. Anything else, or any git/JSON failure, means "not a cut" and §3b runs unchanged. (2) §3b's fragment list is now `git diff --name-only --no-renames --diff-filter=AM`, so only ADDED or MODIFIED fragments satisfy it. `scripts/lint-no-direct-destructive.js` allowlists `release-cut-diff.mjs` (a pre-compile script that cannot import the SafeGitExecutor funnel, same as `release-skip-annotate.mjs`). Two test fixture copy-lists gain `release-cut-diff.mjs` because the gate now imports it.

**Governing specs.** `docs/specs/PRE-PUSH-RELEASE-FRAGMENT-GUARD-SPEC.md` (§3b's origin) states as a correctness property: "No false positive on the release-cut commit." That held while §3b looked only at `src/`. `docs/specs/RELEASE-FRAGMENT-GATE-SPEC.md` D6 then moved §3b onto the shared predicate, which counts package.json, and the property silently broke. The exemption restores it. The same spec defines the fragment requirement as "the PR adds/modifies no `upgrades/next/*.md` file" (Layer 1, add-vs-modify known from the files API). The `--diff-filter=AM` change brings §3b into line with that definition; it had counted deletions too.

**Why 5a90d6be7 was refused.** Git's default rename detection reported `R097 upgrades/next/invite-approval-owner-from-verified-operator.md → upgrades/1.3.1359.md`, and `--name-only` listed only the new path, so fragmentChanges was 0 while package.json and package-lock.json were release-relevant. The base was origin/main (that clone has no JKHeadley remote). After this change a cut passes only through the exemption, which is what the gate's comment now says.

**Review round 1 (Echo, at cbb49d5c2):** version must increase, and §3b counts only added/modified fragments with renames off. Both are in this change. The local release tool that was in the first revision of this PR moved to its own branch, pending its own spec.

## Decision-point inventory

- `pre-push-gate.js §3b` release-fragment check — modify — exempts exactly a release-cut diff, and counts only added/modified fragments (renames off).
- All other gate checks (§1 guide validation, §2 version, §3c internal-only lane, §5 side-effects, lints) — pass-through, unchanged.

---

## 1. Over-block

The gate now blocks less, not more. Residual over-block: a release cut that ALSO legitimately changes something else (for example a hand-fixed lockfile) is still refused by §3b. That is intended: such a push is not purely a cut, and needs a fragment or its own PR. A prerelease version (`1.4.0-rc.1`) is not recognised as a cut, because the versioned-guide naming the rest of the pipeline uses is `X.Y.Z` only.

The tightened fragment count newly refuses a release-relevant change whose only fragment activity is deleting a fragment. That is intended: such a change ships behavior with no note of its own. A legitimate cleanup PR that deletes stale fragments AND touches release-relevant files now needs its own fragment (or to be split).

## 2. Under-block

A push that is byte-for-byte a release cut but was produced by hand (someone bumps the version, renames a fragment into a versioned guide) passes §3b. That is the same content the release pipeline would produce, and the other checks still run: the versioned guide is validated by §1 and by `check-upgrade-guide.js`, and §2 refuses a version that goes backwards. It cannot carry code, dependency or script changes, so it cannot ship behavior without a note.

## 3. Level-of-abstraction fit

The exemption sits where the false refusal happens (the local gate's §3b), and is decided by a pure function with its own tests rather than more inline logic in the gate. It does not change the shared release-relevance predicate (`release-relevant-paths.mjs`), which is right: package.json IS release-relevant for ordinary PRs, and the PR-time server gate shares that predicate. 

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface of its own beyond narrowing an existing deterministic push gate.

The pre-push gate is a deterministic safety check on an irreversible action (a push to main), which the principle allows. This change removes a false positive from it for one exactly-specified shape; it adds no new blocking logic. Every uncertain case resolves to the old behavior.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. "Is this diff a release cut?" is an enumerable structural invariant (which files, which JSON fields), not a judgment between conflicting live signals.

## 5. Interactions

- §1 of the gate: after a cut there are no fragments, so §1 validates the versioned guide (unchanged behavior). §2 then warns that the version equals the newest guide; that warning already fires after every cut and stays a warning.
- §5 side-effects check: no in-flight notes after a cut, so it does not fire (unchanged).
- `.husky/pre-push` still runs the Stage-B fingerprint check, fixture guard and smoke tests on a release push; nothing there is exempted.
- Layer 1 (the PR-time `check-release-fragment.mjs`) exempts the release bot by identity (D9). This exemption is keyed on diff CONTENT, not on a title or author, so it cannot be spoofed into carrying behavior: a diff that matches can only change version fields, add the versioned guide and delete fragments.
- publish.yml is untouched and keeps committing with `HUSKY=0`; the exemption does not change what it does.
- Test fixtures that copy the gate's imports into a scratch dir now copy `release-cut-diff.mjs` too (`tests/unit/pre-push-gate.test.ts`, `tests/integration/duplicate-build-guard-gates.test.ts`); without it the gate would fail to import there.

## 6. External surfaces

None. The pre-push gate is maintainer tooling that runs in husky locally; nothing ships to agents' runtime behavior.

## 6b. Operator-surface quality

Not applicable — no dashboard, approval page or grant/secret form is touched.

## 7. Multi-machine posture (Cross-Machine Coherence)

Not applicable — a local git hook with no agent state. Each machine runs the same gate against its own clone.

## 8. Rollback cost

Revert the PR. The gate goes back to refusing release commits pushed with hooks on, and to counting deleted fragments (the pre-existing state). Nothing is migrated and no agent state is involved.

## Conclusion

Restores a correctness property the governing spec states (cuts pass §3b) and closes a pre-existing hole (deleted fragments satisfied §3b), both keyed on exact structural rules. Every check was mutation-tested. Second-pass review: Echo reviewed the first revision (round 1 above); her re-review of this head is the second pass.

## Evidence pointers

- Real cut 5a90d6be7 (v1.3.1359): refused by the old gate, accepted by the new one ("Release cut v1.3.1359 recognised", exit 0).
- `tests/unit/release-cut-diff.test.ts` (29), `tests/unit/pre-push-gate.test.ts` (19).

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. (The defect is in maintainer push tooling; its guard is the new unit and integration tests.)
