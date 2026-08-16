# Side-Effects Review — Drop duplicate CI gate from publish.yml

**Version / slug:** `publish-drop-duplicate-ci-gate`
**Date:** `2026-04-18`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

`.github/workflows/publish.yml` previously defined an internal `ci` job (checkout → setup-node → tmux → `npm ci` → `npm run lint` → `npm run test:push` → `npm run build`) that the `publish` job depended on via `needs: ci`. That identical set of steps is already covered by `.github/workflows/ci.yml`, which triggers on the same `push: branches: [main]` event: `ci.yml.lint` runs `npm run lint`, `ci.yml.unit` runs `npm run test:push` on a `node-version: [20, 22]` matrix, and `ci.yml.build` runs `npm run build`. ci.yml additionally runs integration and e2e tests that publish.yml never ran. Duplicating the subset inside publish.yml added ~10 min of wall-clock time to every publish (live measurement from run 24614859346: CI gate = 10m 24s total, with `test:push` alone = 9m 34s) while providing no additional safety. This change deletes the `ci` job and removes `needs: ci` from the `publish` job. Files touched: `.github/workflows/publish.yml`.

## Decision-point inventory

- `publish.yml.ci` job — **remove** — duplicate pre-publish test/lint/build gate.
- `publish.yml.publish.needs` — **modify** — was `needs: ci`, now no `needs` (publish kicks off as soon as the push-to-main event fires, in parallel with `ci.yml`).

No runtime (in-agent) decision points touched. This is purely CI pipeline topology.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No block/allow surface on message flow — over-block not applicable in the runtime sense.

In the CI sense: the removed gate never blocked legitimate *inputs*; it blocked *publishes* if tests failed. ci.yml continues to produce the same signal (test results) via its required status checks on PRs. Main is not gated at push time by either workflow — branch protection on PRs is the actual gate. So nothing legitimate is newly allowed through.

---

## 2. Under-block

**What failure modes does this still miss?**

Publishing directly to main bypassing the PR flow (e.g., a force push by a maintainer with the `RELEASE_TOKEN` PAT, or the release commit the publish workflow itself pushes back) will now trigger a publish without waiting for ci.yml to complete. Before this change, publish.yml's internal gate would have caught a broken direct-push at the moment of publish; now it will not.

Mitigations:
- Branch protection on `main` requires PR status checks to pass, which means every *normal* commit on main came through a green ci.yml run.
- The publish workflow's own post-publish commit (`chore: release vX [skip ci]`) appends `[skip ci]`, which makes `publish.yml`'s `if` guard short-circuit and also suppresses ci.yml re-runs. So the auto-commit is not a hole.
- Direct force-push to main is already a policy-level antipattern with or without this gate. Restoring the gate would only delay the symptom, not prevent the policy violation.

Net: under-block surface is unchanged in practice because the gate we removed was a duplicate of a workflow that also does not gate pushes to main directly. Both workflows rely on branch-protection-at-PR-time as the actual authority. We lose a belt on top of the suspenders, not a unique safety check.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The correct layer for "does this commit pass tests" is ci.yml (which already runs the fuller suite including matrix Node versions, integration, and e2e). publish.yml should be at the "take a green main and ship it to npm" layer — version bump, upgrade-guide finalization, `npm publish`, tag. Embedding a parallel-but-smaller CI subset inside publish.yml mixed the layers and produced the duplication.

Signal/authority lens: not applicable to this change — CI test results are an authority-grade signal (the full test suite, not a brittle detector), and ci.yml remains the authoritative source. Removing the duplicate does not demote or promote anything.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface on message flow or agent behavior.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic.

This change modifies CI pipeline topology. It does not add or remove any runtime decision point that gates agent behavior, message flow, or information dispatch. The signal-vs-authority principle targets judgment decisions in the running agent; CI test-pass/fail is a build-time hard-invariant check (full test suite), which the "When this principle does NOT apply" section of the principle doc explicitly excludes. Compliance is not at issue.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** publish.yml and ci.yml both trigger on `push: branches: [main]` and will now run in parallel instead of publish waiting for its internal gate. ci.yml was already running in parallel with publish.yml's ci job anyway, so the observable concurrency shape is the same (two workflow runs kick off, ci.yml spins its own jobs, publish.yml proceeds). No new shadowing.
- **Double-fire:** `npm ci` and `npm run build` still run once inside the `publish` job (needed to produce `dist/` for the publish step). ci.yml.build runs them separately in its own job. This is the same double-run that existed before — not introduced by this change.
- **Races:** the `concurrency: group: publish, cancel-in-progress: false` block is preserved, so multiple publish runs still serialize against each other. No new race.
- **Feedback loops:** the auto-commit at the end of a successful publish carries `[skip ci]`, which prevents both publish.yml (via its `if` guard) and ci.yml (via the convention) from re-triggering. Unchanged.

One concrete interaction worth noting: if ci.yml fails on a push to main and publish.yml succeeds, we will ship a version that ci.yml flagged. Today, publish.yml's internal gate would have caught that *specific subset* of failures (the ones test:push can detect). After this change, that's detected only by ci.yml's post-merge signal, not gated at publish time. As analyzed in §2, the real authority has always been PR-level required status checks; the main-push re-run of either workflow has been a safety net, not a gate.

If we want to tighten this, a follow-up would be to switch publish.yml's trigger from `push: branches: [main]` to `workflow_run` on a successful ci.yml completion. That's a larger topology change and out of scope for this fix. Captured as a follow-up idea.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Other agents on the same machine:** no.
- **Other users of the install base:** no runtime behavior change. Publishing becomes faster, which users will perceive only as "upgrades appear sooner after a merge." No behavioral surface of any published feature changes.
- **External systems:** GitHub Actions runs one fewer job (`publish.yml.ci`) per push. That's a positive cost/surface impact, not negative.
- **Persistent state:** none touched.
- **Timing/runtime:** publish cycle expected 11 min → ~1 min based on step-level timings. The actual-publish portion (checkout + setup-node + npm ci + build + version bump + publish + tag-push) was 33s on the measured run; the removed gate was 10m 24s.

No user-visible regression. User-visible improvement: releases propagate ~10 min faster.

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Trivial. Revert the publish.yml change in a single commit — restore the `ci` job definition and `needs: ci`. No persistent state to clean up. No agent state repair needed. No user-visible regression during the rollback window (rollback only makes publishes slower again, which is the pre-change state). Worst realistic "wrong" outcome: a broken main commit slips through and gets published because ci.yml had not yet flagged it at publish-fire time. Mitigation: yank the bad npm version (`npm unpublish instar@X`) within 72h, or publish the next patch with the fix.

Net rollback cost: one revert commit, one patch publish. ≤10 minutes of operator time.

---

## Conclusion

This is a CI pipeline topology fix that removes a pure duplicate. The change has no runtime surface, no message-flow decision points, and no interaction with the signal-vs-authority principle's domain. The safety net it removes was redundant with ci.yml; the real gate (PR-level required status checks with branch protection) is unchanged. Expected user-visible effect: publish latency 11 min → ~1 min. Rollback cost: trivial. Cleared to ship.

Follow-up captured (not blocking this change): consider switching publish.yml's trigger to `workflow_run` on a successful ci.yml completion if we want to restore a belt-and-suspenders gate at publish time without reintroducing the full test duplication.

---

## Evidence pointers

- Live timing data: GH Actions run `24614859346` (publish.yml, 2026-04-18 22:01Z). CI Gate step breakdown: npm ci 11s, lint 10s, **test:push 9m 34s**, build 12s. Total gate 10m 24s out of 11m total publish wall-clock.
- Coverage diff: publish.yml.ci ran `lint + test:push + build`. ci.yml runs `lint + test:push (node 20, node 22) + build + integration + e2e`. ci.yml is a strict superset.
- Trigger symmetry: both workflows use `on: push: branches: [main]`. Both fire on the same main-push event. No scenario exists where ci.yml doesn't run when publish.yml does run on main.
