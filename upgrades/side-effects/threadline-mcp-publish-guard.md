# Side-Effects Review — threadline-mcp publish guard (#2243)

**Version / slug:** `threadline-mcp-publish-guard`
**Date:** `2026-11-04`
**Author:** `Echo`
**Second-pass reviewer:** `not run (Tier 1, CI workflow and test only)`

## Summary of the change

Tier 1. `.github/workflows/publish-threadline-mcp.yml` and one new test, `tests/unit/publish-threadline-mcp-workflow.test.ts`. No runtime code in instar or threadline-mcp changes.

- The packed-consumer smoke step drops the `pair status` assertion. The `pair` CLI and its argv dispatch were removed in 0.5.1 (32ee7e3be). The step now asserts that the installed package's version equals the tree's.
- The publish job's `check` step sets `publish=true` only when the local version is strictly newer than `npm view threadline-mcp version` (numeric x.y.z compare). An E404 counts as `0.0.0`. Any other registry error fails the step. The `npm version patch` path and the "Commit version bump" step, which pushed to main with `RELEASE_TOKEN`, are removed. Both npm steps are gated on `steps.check.outputs.publish == 'true'`.
- `on.push.paths` narrows from `packages/threadline-mcp/**` to `src/**`, `package.json`, `package-lock.json`, `tsconfig.json` and the workflow file.

## Decision-point inventory

- Publish decision (`check` step) — modify — from "equal means bump and publish" to "newer means publish, otherwise skip".
- Workflow trigger paths — modify — narrower.

---

## 1. Over-block

A README- or `server.json`-only change no longer triggers a run, so it reaches npm only with the next version bump. `workflow_dispatch` still exists, but it publishes only if the version is newer. The registry README can therefore lag the repo until a release, which is intended. A transient npm error now fails the publish job instead of attempting a publish; re-running the job recovers.

---

## 2. Under-block

A pre-release or otherwise non-`x.y.z` version on either side fails the step with "not x.y.z" instead of publishing. No such version exists today. Supporting one would need a deliberate change.

---

## 3. Level-of-abstraction fit

The decision stays inline in the workflow, which is where the old one lived, and the test executes that exact script under `bash -e`. Moving it into `scripts/` would put it under the decision-audit gate's runtime-path scope for no behavioral gain.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] ⚠️ Yes, with brittle logic — STOP.

"Is the local version newer than npm's" is an enumerable comparison over release automation, not a judgment over agent or user content.

---

## 5. Interactions

- The old bump commit carried `[skip ci]` to avoid re-triggering. With no bump commit, that guard on both jobs is now only relevant for other `[skip ci]` commits, and it is kept.
- Merging this PR triggers one run, because the workflow file is in `paths`. With 0.6.1 both in the repo and on npm, the test job runs and the publish job skips. This is the first time the test job can pass since 0.5.1.
- `RELEASE_TOKEN` is no longer referenced by this workflow. It remains a repo secret used elsewhere.

---

## 6. Rollback

A plain revert restores the old trigger, the auto-bump and the stale assertion. No state or published artifact depends on this change.
