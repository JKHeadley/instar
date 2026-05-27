# Convergence Report — Release-Readiness Visibility

**Spec:** [docs/specs/RELEASE-READINESS-VISIBILITY-SPEC.md](../RELEASE-READINESS-VISIBILITY-SPEC.md)
**ELI16 companion:** [docs/specs/RELEASE-READINESS-VISIBILITY-SPEC.eli16.md](../RELEASE-READINESS-VISIBILITY-SPEC.eli16.md)
**Slug:** `release-readiness-visibility`
**Topic:** 14100 ("Release Hygiene")
**Author:** echo
**Converged at:** 2026-05-27 (iteration 3 + v3-final polish)
**Iterations:** 3
**Final-round material findings:** 0 (3 LOW polish items absorbed in v3-final pass; 2 LOW-MED items elevated to v3-final by adversarial review)
**Reviewers:** 5 internal (security, scalability, adversarial, integration, lessons-aware). External cross-model (GPT/Gemini/Grok) deferred per the documented abbreviated-convergence allowance — framework-API approval not granted for this spec.

---

## ELI10 Overview

This spec fixes a class of bug we just got bitten by: **a robot helper that trusts whatever happens to be on the local laptop, then goes completely quiet when it decides to do nothing.** The bite came in two flavors that turned out to share a root: (a) npm publishing silently stopped for a whole minor release worth of work — green merges, green tests, no published package, no alert — because nobody filled the upgrade notes; (b) our "whiteboard" that's supposed to auto-list every shipped feature missed the freshest one because it only looks at the folder on the developer's branch, which is usually a throwaway side-copy. Both have the same shape: a self-driving loop that trusts the wrong source and stays silent when it skips.

The fix is one sentence applied three places: **read the canonical shared copy (main), and speak up whenever you skip.** Concretely: (1) the release-notes file gets auto-filled from the change-list the existing tool already computes — but with a "needs-human-review" stamp that BOTH publish gates reject until a reviewer signs it off (the reviewer signs by adding a content-hash line so they can't pass the gate by just stripping the stamp); (2) a cheap timer-check runs against main, and quietly raises one flag on the attention list when finished features sit unshipped too long — never a chat buzz unless it's really overdue; (3) the whiteboard learns to read main directly (not the local laptop) and leaves a note when it skips work it should have registered. The whole thing ships with a kill-switch endpoint (so an agent can revert if it goes wrong) — but the kill-switch itself raises a high-priority alert so it can't be used to silence the alarm without anyone noticing.

The tradeoff the design accepts: we deliberately leave OUT forcing every single commit to update the release notes (it'd be redundant friction once auto-fill + the alarm exist), and we deliberately leave OUT a content-quality LLM review of auto-drafts (that'd be a separate spec; this one is about *visibility*, not content gating). What we get back is that the original silent-stall failure mode becomes structurally impossible.

## Original vs Converged

What the three review rounds actually changed (in plain English):

- **Originally:** auto-fill would have shipped junk. The existing change-list tool emits fallback strings like *"Review the commit for specifics"* for any commit without structured metadata. Those strings PASS the publish gate (which only checks section presence, not content). So v1's auto-fill would have happily filled the notes with "Review the commit," and the publish workflow would have shipped that fleet-wide as the user-facing notes. **After review:** auto-fill writes a `HUMAN-REQUIRED` marker for those fallback strings; the publish gates were taught to reject any release-notes file with unreviewed markers; a human signals review by adding a hash-locked attestation line tied to their git identity. (Iter-1 Adversarial: SERIOUS → addressed.)

- **Originally:** the alarm could silence itself. v1's "release is blocked" detection reused the same code that auto-fill cleared. So Layer A clears NEXT.md → Layer B sees "no longer blocked" → the alarm goes quiet, while the actual published content is junk. **After review:** the alarm's "blocked" check was decoupled from NEXT.md state — it gates on unreleased feature commits without a covering tag, independent of whether the file looks healthy. Auto-draft alone can never clear the alarm. (Iter-1 Adversarial: SERIOUS → addressed.)

- **Originally:** the whiteboard fix would have been catastrophically slow. With ~178 specs on main and a per-spec `git merge-base` check every 6 hours, the reconciler would have spawned ~356 git processes per tick — seconds of synchronous shell-outs on every reconciler beat. **After review:** the scan was redesigned to use a single batched `git ls-tree` + a single `git log --name-only` ancestry pass, with the reading restricted to specs newer than the last-processed commit. Steady-state cost is "only what's actually new." (Iter-1 Scalability: SERIOUS → addressed.)

- **Originally:** the spec said the readiness check would invoke `analyze-release.js --ref=FETCH_HEAD` — except that flag doesn't exist. The script hardcodes `tag..HEAD`. So as-written, Layer B would have silently run against the local branch — recreating the exact silent-failure bug it was supposed to fix. **After review:** the spec now explicitly enumerates the prerequisite script changes (add the `--ref` parser, thread it through five helpers), splits the work into three PRs in dependency order, and requires a real CI gate (`--ref=<known SHA>` must produce different output from `--ref=HEAD`) so the script change actually landed — not just "the flag was silently accepted." (Iter-2 Scalability: SERIOUS → addressed.)

- **Originally:** human "review" of the unreviewed marker was just `sed -i 's/auto-draft-unreviewed//'`. A tired reviewer, or a script, could strip ~30 bytes and pass the gate. **After review:** removing the marker is only valid if accompanied by a hash-locked `reviewed-by` receipt; the hash captures the section content at review time, so a later edit silently invalidates the receipt and re-blocks publish. (Iter-2 Adversarial: HIGH → addressed.)

- **Originally:** the `canonicalRemote` config was a quiet kill-switch — point it at an up-to-date fork and the alarm silences itself forever. **After review:** the canonical-remote URL is allow-listed against the actual `github.com:JKHeadley/instar` pattern (anchored on the known host); overrides are still permitted (forks legitimately exist) but raise a HIGH-priority Attention item at startup and stamp the state file with `canonicalRemoteOverridden: true` until reverted. (Iter-2/3 Adversarial: addressed.)

- **Originally:** the rollback path was a script under `scripts/` — but agents installed via npm don't receive that directory. So "rollback" required cloning the repo. **After review:** rollback is an authenticated `POST /release-readiness/rollback` endpoint, callable from any agent session. AND because that endpoint is itself a silencing surface, every invocation MUST raise a HIGH-priority Attention item, write to the sentinel audit trail, and append to a `rollbackHistory[]` log — the rollback can't be used to silently disable the alarm. (Iter-2 Integration + Iter-3 Adversarial: addressed.)

## Iteration Summary

| Iteration | Reviewers verdict | Material findings | Spec sections changed |
|-----------|-------------------|-------------------|-----------------------|
| 1 | All 5 returned: 2 SERIOUS, 3 MINOR | 5 serious + 8 minor | §4.1 (sanitization + unreviewed-marker + race guard), §4.2 (decoupled-blocked + cache + fail-loud + lifecycle owner + observability route), §4.3 (batched scan + feature-flag + skip-signal scoping), §7 (migration shape), §10 (rollback checklist). v1→v2 rewrite. |
| 2 | 2 CONVERGED (security, lessons-aware), 3 NEEDS-ITER-3 | 1 SERIOUS (`--ref` flag absent) + 7 material | §4.1.1 (review-receipt attestation), §4.2.2 (canonical-remote allow-list + fetch coordination + explicit script-change enumeration), §4.2.5 (resolveEpisodesInRange), §4.2.7 (rollback endpoint + multi-machine header), §4.3.3 (first-tick K=1), §7 (migrateClaudeMd block), §10 (PR sequencing). v2→v3 rewrite. |
| 3 | All 5 CONVERGED | 0 SERIOUS/HIGH; 2 LOW-MED elevated by adversarial as "should land in v3-final, not iter 4" + 6 LOW polish | §4.1.1 (`:hash=` required + canonicalization spec + anti-bypass-vs-anti-impersonation note), §4.2.2 (regex tightened to github.com anchor + 60s=2×fetchTimeout note), §4.2.7 (rollback raises HIGH-Attention + sentinel audit + rollbackHistory[]), §7 (CLAUDE.md migration covers both endpoints), §10 (CI gate strengthened + required-status + PR-3 mirror). v3-final polish pass (no iter 4). |

## Full Findings Catalog

### Iteration 1

**Security — MINOR ISSUES (1 elevated).** (1) Prompt-injection via commit messages flowing into fleet-wide guide; (2) forged `<!-- bump: -->` markers; (3) Layer B fail-open contradicts thesis; (4) unbounded git fetch cost; (5) race vs publish-finalize. **Resolutions in v2:** §4.1.1 sanitization (strip HTML comments, length-cap, escape, line-start-only markers), §4.1.1 unreviewed-marker poison-pill, §4.2.6 fail-loud normative, §4.2.2 bounded fetch + signal on failure, §4.1.3 advisory lock + post-finalize check.

**Scalability — SERIOUS ISSUES.** (1) Layer C per-spec git fan-out ~356 calls/6h; (2) Layer B per-tick uncached diff loop; (3) `git fetch` no timeout; (4) growth/reaping unspecified; (5) fail-open re-creates the bug. **Resolutions in v2:** §4.3.2 batched `ls-tree` + single ancestry pass + per-tick cursor scope; §4.2.3 SHA-keyed cache; §4.2.2 bounded fetch with 30s timeout; §4.2.5 `reapStaleEpisodes` 30d TTL; §4.2.6 fail-loud normative.

**Adversarial — SERIOUS ISSUES.** (1) Auto-fill defeats publish gate via fallback text passing section-presence; (2) Layer A clears Layer B's block conditions → alarm silences itself; (3) flap/threshold reset gaming; (4) Layer C false-positive on legitimate non-registrations + false-negative on renames/deletes; (5) stale local main; (6) analyze-release runs HEAD not main. **Resolutions in v2:** §4.1.1 unreviewed-marker rejected by BOTH gates + placeholder-neutralization; §4.2.3 blocked-predicate decoupled from NEXT.md state; §4.2.4 oldest-commit-age + 12h hysteresis + stable SHA-keyed dedupe; §4.3.3 "should have registered" scoped to (approved + non-meta + not-on-skip-list), rename = update, delete = non-skip; §4.2.2 mandatory bounded fetch (Open Decision 1 resolved normative); §4.2.2 analyzer invoked with `--ref=FETCH_HEAD`.

**Integration — MINOR ISSUES (six).** (1) Migration mechanism for new job under-specified; (2) config-defaults migration shape unspecified; (3) Layer C boot fragility / not config-gated; (4) rollback residuals not enumerated; (5) multi-machine dedupe gap unclear; (6) dashboard/observability surface absent. **Resolutions in v2:** §4.2.1 + §7 names `src/scaffold/templates/jobs/instar/release-readiness-check.md` + `InstallBuiltinJobs` always-overwrite + `migrateBuiltinJobs`; §7 names config keys + `migrateConfig`; §4.3.1 feature-flag default-off + try/catch fallback never throws into boot; §10 explicit rollback checklist; §10 multi-machine clarification; §4.2.7 new `GET /release-readiness` route + CLAUDE.md template mention.

**Lessons-aware — MINOR ISSUES.** (1) Own-the-lifecycle pattern not engaged for Layer B (no owner class, no race guard against `finalizeGuide()`); (2) supervision tier undeclared; (3) dedupe-key stability not specified (risk of the resettable-id scar from `feedback_notifications_near_silent`). **Resolutions in v2:** §4.2.5 introduces `ReleaseReadinessSentinel` as lifecycle owner with `isEpisodeActive(commitSha)` race guard + `reapStaleEpisodes`; §4.2.1 declares Tier 0 with mechanical-computation justification; §4.2.4 dedupe keyed on oldest-unreleased-commit SHA + 12h hysteresis.

### Iteration 2

**Security — CONVERGED.** All 5 iter-1 findings adequately addressed. Three wording-level new notes: (N1) clarify the advisory lock is intra-host only; (N2) acknowledge field set on `GET /release-readiness` is non-sensitive; (N3) cross-feature fetch-failure dedupe between Layer B + Layer C. **Resolutions in v3:** §4.1.3 NB on intra-host scope; §4.2.2 fetch-failure dedupe between B & C.

**Scalability — NEEDS-ITER-3 (1 SERIOUS blocker).** **N1 SERIOUS:** spec asserts `analyze-release.js --ref=FETCH_HEAD` exists; it does not — script hardcodes `${tag}..HEAD`. As-written, Layer B silently runs against local HEAD → recreates the exact silent-failure bug being fixed. **N2 MEDIUM:** cache-miss path still pays per-file diff cost. **N3 LOW:** concurrent fetch race. **N4 LOW:** `cat-file --batch` unbounded. **Resolutions in v3:** §4.2.2 enumerates the precise script changes (add `--ref` parser; thread through 5 helpers) + §10 PR-1 prerequisite + CI gate; §4.2.3 explicit cache-miss cost justification (release-cadence not cron-cadence); §4.2.2 in-process `Map<remote,Promise>` + `flock` advisory lock; §4.3.2 steady-state O(new specs only).

**Adversarial — NEEDS-ITER-3 (2 HIGH/MEDIUM, 3 LOW).** **N1 HIGH:** unreviewed-marker review = stripping ~30 bytes; tired-human/script bypass. **N2 MEDIUM:** `canonicalRemote` config is a kill-switch. **N3 MEDIUM:** `isEpisodeActive` keyed on oldest-at-detection SHA; SHA churn misses. **N4 LOW:** K=3 first-tick = 18h silent baseline. **N5 LOW:** non-leader cache lag invisible. **Resolutions in v3:** §4.1.1 review-receipt attestation; §4.2.2 allow-list + HIGH-priority Attention on override; §4.2.5 `resolveEpisodesInRange(lastTagSha, newTagSha)`; §4.3.3 first-tick K=1; §4.2.7 `X-Readiness-Source` header.

**Integration — NEEDS-ITER-3 (3 LOW-MEDIUM).** **N1 MEDIUM:** `migrateClaudeMd` block missing → existing agents diverge from new agents (Migration Parity violation). **N2 LOW:** prepublish backward-compat for the new `--ref` flag untested. **N3 LOW:** `rollback-release-readiness.mjs` lives under `scripts/` — agents don't receive that on npm update. **Resolutions in v3:** §7 explicit `migrateClaudeMd` bullet with content-sniff on `/release-readiness` marker; §6 + §7 unit test asserting `--ref` absent ⇒ today's behavior; §4.2.7 + §10 rollback is an authenticated endpoint, not a local script.

**Lessons-aware — CONVERGED.** All 3 iter-1 findings cleanly addressed (§4.2.5 lifecycle owner mirrors `CompactionSentinel` pattern; §4.2.1 Tier 0 declaration; §4.2.4 SHA-keyed stable dedupe with explicit callback to the documented scar). No new principle contradictions.

### Iteration 3

**Security — CONVERGED.** All v2 wording notes absorbed. Three LOW recommended fast-follows: audit-log on rollback (absorbed in v3-final §4.2.7), hash canonicalization spec (absorbed in v3-final §4.1.1), receipt↔commit-author binding (tracked as a Phase-2 follow-up; noted in v3-final §4.1.1).

**Scalability — CONVERGED.** All 4 iter-2 findings addressed with code-grounded fixes. Two LOW additions: NF1 — note 60s = 2× fetchTimeoutMs (absorbed in v3-final §4.2.2); NF2 — strengthen PR-2 CI gate to use a known prior-release SHA so a silently-ignored flag fails the gate (absorbed in v3-final §10).

**Adversarial — CONVERGED WITH TWO SMALL v3-FINAL EDITS.** All 5 iter-2 findings cleanly closed. **V2 LOW-MED:** require `:hash=` (not optional) on the review-receipt — absorbed in v3-final §4.1.1. **V5 MEDIUM:** rollback MUST raise HIGH-priority Attention + write to `logs/sentinel-events.jsonl` + `rollbackHistory[]` (otherwise the rollback endpoint is itself a silent-failure surface — exactly what this spec exists to prevent) — absorbed in v3-final §4.2.7. **V1 LOW:** receipts are anti-bypass, not anti-impersonation — noted as a scope clarification in v3-final §4.1.1, with stronger identity binding tracked as Phase 2. **V3 LOW:** canonical-remote regex tightened to require `github.com` host anchor — absorbed in v3-final §4.2.2. **V4 LOW:** out-of-order Tag race in `resolveEpisodesInRange` — design holds (ancestry check is idempotent under either order); no change needed.

**Integration — CONVERGED.** All 3 iter-2 findings substantively addressed. Three LOW polish items absorbed in v3-final: (I3-N1) PR-2 CI gate as required-status check in branch protection (absorbed in §10); (I3-N2) PR-3 mirror gate (absorbed in §10); (I3-N3) CLAUDE.md migration block covers BOTH endpoints (GET status + POST rollback) so agents learn the revert path alongside the status path (absorbed in §7).

**Lessons-aware — CONVERGED.** Targeted re-check against the five v3 areas (review-receipt vs. signal-vs-authority, canonical-remote allow-list vs. structure-vs-willpower, `resolveEpisodesInRange` vs. own-the-lifecycle, rollback endpoint vs. signal-vs-authority, first-tick K=1 vs. near-silent) — all clean. No new principle/lesson contradictions.

## Convergence Verdict

**Converged at iteration 3 + v3-final polish pass.** The final review round produced zero SERIOUS or HIGH findings; two LOW-MED items the adversarial reviewer explicitly flagged as "should land in v3-final, not iter 4" were absorbed in-spec along with the LOW polish items. The five reviewers' iter-3 verdicts: CONVERGED across the board.

The spec's three layers and the unifying principle (canonical-source + speak-on-skip) survived review intact; the rewrites strengthened sanitization, decoupled the alarm from the file it auto-fills, made the canonical-source read normative and feature-flagged, gave the lifecycle a named owner with a real race-guard against publish-finalize, and turned the rollback endpoint from a potential silencing surface into a loud-and-audited one.

**Phase-2 hardening (tracked, not blocking ratification):** (a) bind the review-receipt's git-identity to the commit author of the strip via post-hoc `git log -p` verification; (b) batch the four `getFileDiff` passes in `analyze-release.js` into a single whole-range diff walk.

**Spec is ready for user review and approval.**

To approve: edit the spec's frontmatter to set `approved: true` (or run `instar spec approve release-readiness-visibility`), then `/instar-dev` can proceed with implementation, following the three-PR sequencing in §10.
