# Side-Effects Review — open-PR overlap shown at every instar commit

**Version / slug:** `open-pr-overlap-at-commit`
**Date:** `2026-11-12`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1. `scripts/instar-dev-precommit.js` (the instar repo's commit hook) now calls `checkOpenPrOverlap` from the new `scripts/lib/open-pr-overlap.mjs` right after it reads the staged files and before its scope exit, so every commit — including a docs/plan-only commit — is compared against the files of every other active open PR on GitHub (`gh pr list --json files`). Matches print a boxed notice naming each PR, branch and shared file. PRs untouched for 14 days are skipped; files changed by 6+ of ALL active open PRs (wiring hubs such as `src/commands/server.ts`) are summarised in one line instead of listed — never silent; release bookkeeping paths never count; the session's own branch is excluded. Driven by Echo Bugs topic 10000002588 (two machines changed the same reply-delivery code on 11 Nov; the existing `instar dev:claim-check` only runs when a session remembers). Size: 2 runtime-script files (~230 lines incl. comments), one new unit test file, one line in an e2e copy list. Effort: no spec review rounds (Tier 1); one commit attempt planned.

## Decision-point inventory

- `instar-dev-precommit.js` Step 1.2 (new) — add — prints an overlap signal; never changes the exit code. Every existing step is pass-through.

---

## 1. Over-block

No block/allow surface — over-block not applicable. The check never changes the hook's exit code; every failure path returns a status object and the hook continues.

---

## 2. Under-block

No block/allow surface. As a signal it still misses: (a) overlap before the other session opens a PR (local-only branches are invisible); (b) semantic overlap without a shared file — a plan-only spec PR such as #3086 vs code PR #3082 shares no file; (c) overlap only through a hub file (one summary line naming the PRs, not a full listing); (d) PRs idle for 14+ days; (e) a match in a PR with more than 100 files (`gh --json files` returns at most 100 per PR); (f) on a detached HEAD the session's own PR can be listed (noise, not a miss). (a) and (b) are what the pool-wide efforts list and plan/build gate are for — filed as fb-c474f83a-5ad <!-- tracked: fb-c474f83a-5ad -->; the hourly cross-machine job is fb-8390730a-16f <!-- tracked: fb-8390730a-16f -->.

---

## 3. Level-of-abstraction fit

Right layer for the first step: the commit hook is the one point every session on every machine already passes through for instar work, and GitHub's open-PR list is the one shared record every machine already writes to. It reuses the same `gh pr list --json files` read as `instar dev:claim-check` and the duplicate-build guard; it does not replace either (the duplicate-build guard is spec-similarity based and only runs when a spec is resolved; claim-check is on-demand).

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

A path match is brittle evidence (two PRs can share a file harmlessly), so it is a signal only: it prints, the session decides. It never blocks and fails open.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point: the 14-day and 6-PR thresholds only decide how a notice is laid out, never whether anything is allowed.

---

## 5. Interactions

- **Shadowing:** runs before Step 1.5 and every gate; it cannot exit, so it shadows nothing. Merge commits are already skipped at Step 0, so merges never run it.
- **Double-fire:** the pre-push duplicate-build advisory may also warn on the same push; different evidence (spec similarity vs file paths), both advisory.
- **Races:** none — read-only `gh` and `git remote get-url` / `rev-parse`; no state written.
- **Feedback loops:** none.
- **Tests that copy the hook into a sandbox:** the e2e report-backing test copies the hook's imports; the new module is added to its list. In sandboxes the origin remote is not the instar repo, so the check skips (`not-repo-clone`) and makes no network call. `lint-no-direct-destructive` is satisfied with the read-only `safe-git-allow` header.
- **Latency:** one `gh` call per commit, ~2–3.5 s measured with 95 open PRs; `gh` capped at 8 s and each of the two read-only git calls at 2 s, so worst case about 12 s, then fails open (one live run did hit the 8 s cap and printed the UNKNOWN line as designed).

---

## 6. External surfaces

- Other agents / install base: none — the hook only exists in the instar source repo; nothing ships to agents' runtime.
- External systems: one read-only GitHub API call per commit via the local `gh` login.
- Persistent state: none.
- Operator surface: no operator-facing actions.

---

## 6b. Operator-surface quality

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**proxied-on-read** — the shared state is GitHub's open-PR list, read live on whichever machine commits; that is what makes another machine's work visible. No user-facing notices (the notice goes to the committing session's terminal only), no durable state, no URLs. Status surfaces: none added or changed.

---

## 8. Rollback cost

Pure script change — revert and merge. No persistent state, nothing on agents. Immediate local off-switch: `INSTAR_PR_OVERLAP_CHECK=off`.

---

## Conclusion

Review changed the design once: the first live run listed 20 PRs for `src/commands/server.ts`, several months stale, which would train sessions to ignore the notice. Added the 14-day active window and the hub-file summary. The second-pass review then found hub-only matches were silent and hubs were counted only among the overlapping PRs (so several sessions on one ordinary file would be hidden); fixed: hubs are counted across all active PRs at 6+, and hub-only matches always print one line (live: `server.ts` → 12 PRs named in one line). Tests added for the reviewer's 4-PR repro; replayed on the real 11 Nov case, PR 3082's files are still flagged against 3 open PRs (5 shared files with #3102). Clear to ship as the first step; the rest of the report is filed (fb-c474f83a-5ad, fb-8390730a-16f, fb-51fa3dca-dcf, fb-43860e3f-1ce, fb-4c703763-559).

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (Claude)
**Independent read of the artifact: concern**

- Hub-only overlap is silent, not "summarised in one line" as §Summary and §2(c) say. When every shared file is a hub, `formatOverlapNotice` returns '' and `checkOpenPrOverlap` returns `clear` with nothing written. Reproduced: 4 active PRs each changing `src/messaging/PendingRelayStore.ts`, then a commit of that file → `status: clear`, no output. Hub status is computed only from PRs that share the staged files, so the busiest collision (several sessions on the same non-wiring file, the 11 Nov class) is the one that gets hidden. Fix: (a) when `overlaps` is empty and `hubOnly` is not, still print the one-line hub summary; and (b) decide hubs from a fixed wiring list (server.ts, routes, templates.ts), or from file frequency across all active PRs with a higher threshold, not from the PRs that share this commit's files. Update the unit test at line 126 that pins the empty notice.
- Worst-case added latency is about 14 s (3 s remote + 3 s rev-parse + 8 s gh), not 8 s. That is minor; fix the §5 Latency line or share one deadline.
- Minor, noise only: `gh pr list --json files` returns at most 100 files per PR, so very large PRs can miss a match. On a detached HEAD, `ownBranch` is null and the session's own PR is listed as an overlap.
- Otherwise verified: the hook cannot exit non-zero or throw (import has no side effects; every path is wrapped; gh missing, signed out or bad JSON → `degraded`). It is signal-only per signal-vs-authority. Every sandbox that copies the hook either copies `scripts/lib` in full or has the new module added to its list, and the sandboxes skip via `not-repo-clone`. The 16 unit tests pass.

**Resolution (author):** concern 1 fixed as recommended (b: frequency across all active PRs, threshold 6; a: hub-only always prints one line; test at old line 126 replaced, reviewer repro added as a test). Concern 2: git timeouts cut to 2 s and §5 corrected to ~12 s worst case. Concern 3: recorded in §2 as known misses/noise; neither affects the hook's exit code.
**Re-review: concur** — I re-ran the repro: 4 PRs on PendingRelayStore.ts now print the full overlap notice, 7 PRs print a one-line hub notice naming every PR, nothing is silent any more, the git timeouts are 2 s, and all 19 unit tests pass.

---

## Evidence pointers

- `tests/unit/open-pr-overlap.test.ts` (19 tests) — overlap, own branch excluded, stale and hub handling, fail-open, skip paths, wiring before the scope exit.
- Live: `checkOpenPrOverlap` with PR 3082's real file list and branch → `overlap [3102:5, 3095:2, 3093:1]` in ~2.5 s.
- Hook suites: duplicate-build-guard-gates (13), converging-audit e2e (5), 9 precommit unit files — all pass.
