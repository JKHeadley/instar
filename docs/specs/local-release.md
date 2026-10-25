---
title: "One-command local release (scripts/release-local.mjs)"
slug: "local-release"
author: "dawn"
status: "approved r3"
approved: true
approved-by: "Justin (topic 61599, 2026-10-20T07:11Z, 'Approved both')"
review-convergence: "2026-10-20T05:55:53Z"
review-notes: "Echo review rounds 1 (2026-10-20T05:31Z), 2 (re-review at 5dc1c8a34) and 3 (db8454e92, converged on her side, plus a wording nit fixed in 2287a8310) on PR #2224. The formal /spec-converge multi-reviewer pass was not run."
eli16-overview: "local-release.eli16.md"
parent-principle: "Friction Is a Spec — Productize the Workaround"
parent-principle-fit: "v1.3.1359 was released by hand-copying publish.yml's steps on a workstation while GitHub's runners were starved: a hard-won manual workaround that recurs whenever CI is starved. This spec turns it into the permanent command npm run release:local. (Sibling fit: Notice + Solve Inefficiencies, since CI starvation throttling releases is a standing inefficiency.) Added in the tool PR after approval, because the commit gate requires it; metadata only, no design change."
---

# One-command local release

> **Status: DRAFT.** Not yet converged or approved. Written 2026-10-20 after Justin's ruling: GitHub's runners have been overloaded for days and are slowing Instar development, so running tests and releases locally should be the default. The implementation described here already exists, uncommitted, on the local branch `feat/release-local-tool`. This spec describes it exactly as built, including Echo's review of the tool on PR #2222 (items 3a–3c) and her round-1 review of this spec on PR #2224 (answered in round 2: no rebase over code, an OTP preflight, each gate ref fetched from its own remote, a `--push-only` resume, and a fail-closed publish.yml-run check), so it can be converged and approved before it is committed.
>
> Depends on PR #2222 (pre-push gate accepts release cut commits). Without it, step 12's push of the release commit is refused by `pre-push-gate.js` §3b.

## Problem statement

A merge to `main` reaches agents only when `.github/workflows/publish.yml` gets a runner. In mid-October 2026 the publish job queued for hours at a time. v1.3.1359 was released by hand on a workstation by copying the workflow's steps one at a time (assemble-next-md → resolve-release-tier → resolve-publish-version → npm version → rename NEXT.md and delete consumed fragments → check-upgrade-guide → npm publish → post-publish-smoke). Two things went wrong with that:

1. A hand-run sequence is a different release from CI's. It is easy to skip a step, run one out of order, or fail open where CI fails closed.
2. The resulting `chore: release vX [skip ci]` commit could not be pushed with hooks on. CI never meets this because its commit step runs with `HUSKY=0`. That gate bug is fixed separately in #2222.

## Proposed design

`scripts/release-local.mjs`, exposed as `npm run release:local`, performs the `publish` job of `publish.yml` on the maintainer's machine. It runs in the same order, calls the same scripts, and fails closed at every step.

**Arguments:**
- `--dry-run` runs every step up to, but not including, `npm publish`, the commit and the push. It prints the version it would publish, then restores the tree.
- `--userconfig <path>` names the npm config file that holds the publish auth. It is passed to `npm whoami`, `npm publish` and the post-failure `npm view`. The script never reads or prints a token.
- `--remote <name>` names the git remote for main. The default is `origin`.
- `--otp-command "<cmd>"` names a command that prints a fresh npm one-time password. It runs right before `npm publish`, and its output is never printed. A static `--otp <code>` is deliberately not offered: a TOTP code typed at the start expires during the build.
- `--token-skips-otp` is the caller's statement that the npm token publishes without an OTP (a granular token with "bypass 2FA", or a classic automation token). It is needed only when the preflight sees that the account requires, or may require, an OTP.
- `--allow-unverified-ci` lets a real run proceed when `gh` cannot say whether a publish.yml run is active. It never overrides a run that IS active.
- `--push-only` resumes after a publish: it lands an already-published release commit and never publishes (see "Push-only resume").
- `--keep-tag-on-published` (with `--push-only` only) pushes the tag on the published commit and lands the release commit on main separately.
- `--allow-dirty-tool-files` (with `--dry-run` only) tolerates uncommitted edits to the tool's own files, and only those: the script, its lib, its two tests, the destructive-lint allowlist, CONTRIBUTING.md and this spec. This lets the real dry run be exercised before the tool can be committed (it can't be committed until this spec is approved). The list deliberately excludes package.json, package-lock.json and upgrades/, because the dry run edits those and then restores them from HEAD, which would discard an uncommitted edit there. A real run with the flag exits 2.
- An unknown argument exits 2 and touches nothing, as do `--keep-tag-on-published` without `--push-only`, `--push-only` with `--dry-run`, and `--allow-dirty-tool-files` without `--dry-run`.

**Steps** (the numbers are the script's step order):

0. **Preflight.**
   - The git top-level must be the script's own repo.
   - `git status --porcelain --untracked-files=all` must be empty.
   - It runs `git fetch <remote> main`, then requires `HEAD == <remote>/main`. A `--dry-run` only warns on a mismatch, so a branch can be rehearsed; a real run refuses.
   - If HEAD's message contains `[skip ci]`, it prints a note and **continues** (changed in round 3). publish.yml's `if:` exists to stop its own release commit re-triggering it; locally there is no loop, and step 4's fragment check already answers "is anything left to release?". Stopping would strand work that merged before a release cut was rebased on top of it. That is main's state right now: the 1.3.1359 cut ee72c9c81 sits over #2222, whose fragment is unreleased. The round-3 dry run shows it.
   - **Gate-base refresh (Echo 3b):** for each of `JKHeadley/main`, `origin/main` and `upstream/main` that exists locally, it fetches that ref **from its own remote**: `git fetch JKHeadley main`, `git fetch origin main`, `git fetch upstream main`. It never fetches from `--remote`. These are the refs `pre-push-gate.js`'s `pickRef` may choose. A ref that exists but cannot be fetched stops the run before anything is published, because the gate would otherwise diff the release commit against a stale base.
   - **publish.yml run check (open question 1; widened in round 3 by Echo's must-settle).** It asks whether **any** publish.yml run on the repo is unfinished, **for any commit**. publish.yml checks out `ref: main`, not its triggering sha, and waits in `concurrency: publish` with `cancel-in-progress: false`. So a run queued for an earlier merge publishes whatever main is when it gets a runner, which would race a local release on the same version. There is no `--commit` filter.
     - It makes one `gh run list -R <owner/repo> --workflow publish.yml --status <s> --limit 100 --json databaseId,status,headSha` query per unfinished status: `queued`, `in_progress`, `waiting`, `requested`, `action_required`. Querying by status means an old queued run can't fall off a page of recent runs.
     - Any run found stops a real run and prints the `gh run cancel` ids. Two publishers must never race.
     - Round-3 finding: the round-2 list included `pending`, which gh 2.64 rejects (`invalid argument "pending" for --status`). Every query therefore failed, and the first real dry run correctly read that as UNKNOWN. `pending` was removed, and a test now checks every queried status against the installed gh's own list of valid values.
     - If `gh` is missing, fails, prints something unparseable, or the owner/repo can't be derived from the remote URL, the answer is UNKNOWN. A real run stops unless `--allow-unverified-ci` is given; it never assumes none.
     - A `--dry-run` only warns.
     - It runs again right before publish, as step 13 of the run, which the dry run reaches too.
     - Real gh output was checked: the round-3 dry run reports "none queued or in progress, for any commit" at both points.
   - `npm whoami` must succeed. In a `--dry-run` this check and the OTP preflight below still run, but they warn ("a real run would stop here") instead of stopping, so the dry run proves them.
   - **OTP preflight (Echo round-1 item 2).** Before anything is mutated, it runs `npm profile get --json` and reads `tfa`:
     - `tfa: false`, `pending`, or mode `auth-only` → not required.
     - mode `auth-and-writes` → required.
     - Anything unreadable (granular tokens often cannot read the profile) → unknown.
     - If it is required or unknown, the run stops here unless `--otp-command` or `--token-skips-otp` was given.
1. `NODE_ENV=development npm ci --include=dev`. A workstation may carry `NODE_ENV=production` or npm `omit=dev`; a CI runner installs dev dependencies by default.
2. `npm run build`.
3. `node scripts/assemble-next-md.mjs`. From this point the script has edited tracked files.
4. **NEXT.md content check**, the same three skip rules as the workflow: NEXT.md is missing; it is still the template (`[Feature name]` and `[Capability]`); or it has an `<!-- auto-draft-unreviewed` comment. On a skip, it runs `git fetch --tags <remote> main` and `node scripts/release-skip-annotate.mjs`, a signal only that always exits 0, then restores the tree and exits 0.
5. **Release tier.** It runs `node scripts/resolve-release-tier.mjs <local> <npm>`.
   - A non-zero exit fails the run.
   - `skip` stops cleanly with the reason and restores the tree.
   - Anything other than `allow` fails the run.
   - The npm version comes from `npm view instar version`. A failure, or a result that is not X.Y.Z, fails closed. **Deviation from CI**, which falls back to `0.0.0`: locally that fallback would let package.json alone choose the version.
6. **Version.** It runs `node scripts/resolve-publish-version.mjs <local> <npm>`. The result must be X.Y.Z. Then it runs `npm version <v> --no-git-tag-version --allow-same-version` and checks that package.json now says `<v>`.
7. It renames `upgrades/NEXT.md` to `upgrades/<v>.md` and deletes `upgrades/next/*.md`.
8. `node scripts/check-upgrade-guide.js`.
9. **prepublishOnly's gates, run up front so `--dry-run` covers them:** `node scripts/verify-codex-stage-b-release-evidence.mjs` and `node scripts/check-contract-evidence.js`. `npm publish` runs them again through `prepublishOnly`.
10. **`npm publish --access public`**, with no `--provenance`, because provenance needs the GitHub Actions OIDC token. The script prints that.
    - If `--otp-command` was given, it runs now and must print a 6–8 digit code; it is passed as `--otp`, and the printed command line shows `--otp <hidden>`.
    - `npm publish` runs with **stdin closed** and a **20-minute timeout**.
      - **Verified against the npm actually run (11.19.1, Echo round-2 item 3).** `lib/utils/auth.js` `otplease` rethrows at once when `!process.stdin.isTTY || !process.stdout.isTTY`. That check comes before both the web flow (`webAuthOpener`, which prints a URL and polls) and the classic prompt. So with stdin closed, a web-OTP challenge becomes an immediate `EOTP` failure, handled below. A test runs the installed npm's own `otplease` with a web-OTP `EOTP` and stdin closed, and requires `REJECTED EOTP` within 5 s. As a control, faking a TTY sends the same call into the web flow (`ENOTFOUND` on the fake URL), so the test does tell the two paths apart.
      - `--auth-type=legacy` was considered and rejected: for publish, npm's web-vs-classic choice comes from the registry's `EOTP` body (`authUrl`/`doneUrl`), not from `auth-type`, so the flag would not change this path.
      - The timeout is a backstop for an npm that someday polls anyway. A timeout is resolved against the registry like any other failure.
    
    **(Echo 3c)** If `npm publish` exits non-zero, it asks `npm view instar@<v> version`:
    - `<v>` → **published.** It continues down the published path, with a message saying so.
    - E404 → **absent.** This is an ordinary failure; it restores the tree and prints "Nothing was published".
    - anything else (network, auth, a different version) → **UNKNOWN.** It stops without restoring the tree and without claiming either way, and prints the `npm view` command to settle it.
11. `node scripts/post-publish-smoke.mjs <v>`.
12. **Commit and push.**
    - It runs `git add package.json package-lock.json upgrades/` and `git commit -m "chore: release v<v> [skip ci]"` **with hooks**.
    - It refreshes the gate-base refs again (a failure here is post-publish: it is reported, and nothing is undone).
    - **(Echo 3b)** It runs `git tag v<v>`, then **one** `git push --atomic <remote> HEAD:main v<v>`, so main and the tag can never disagree.
    - **(Echo 3a)** Before each push it records `<remote>/main`. If the push is refused, it fetches and compares the remote main sha from before the push with the sha after the fetch. HEAD is not part of that comparison.
      - **Unchanged:** a hook or a permission refused the push. It fails at once with the push and hook output. It does not rebase or retry.
      - **Moved — only by release cuts:** it checks every commit on `<remote>/main` that HEAD lacks. A release cut is a non-merge commit whose diff against its parent passes the #2222 cut rule. If all of them are release cuts (so no code), it runs `git rebase <remote>/main`, aborts on conflict and never force-pushes. Then it re-creates the tag on the rebased commit (`git tag -d` + `git tag`) and retries, up to 5 attempts, the same bound as publish.yml. The tagged tree still equals the published tree.
      - **Moved — by anything else (Echo round-1 item 1, her option b):** it **stops without rebasing**. Rebasing would put `v<v>` on a tree containing code the npm tarball never had, and a rollback relies on the tag matching what was published. The version is on npm, so the stop prints the push-only resume commands below.
    - **Runner fix found in round 2:** step 12 used to pass the echoing runner, which does not capture stdout, into the push logic. `rev-parse` then returned empty strings, so every refused push would have been misread as a hook refusal. It now passes the capturing runner, and a test pins that.
13. It prints the release commit and tag. It also says whether publish.yml runs for the shipped merge were checked, or were NOT verified because `--allow-unverified-ci` was given (with the `gh run list` command to check).

**Push-only resume (Echo round-1 item 4).** Any failure after publish prints `node scripts/release-local.mjs --push-only --remote <r> [--userconfig <p>]`, plus `--keep-tag-on-published` for the case where main moved with code. `--push-only`:
- requires a clean tree and a HEAD subject of `chore: release vX [skip ci]`;
- requires HEAD to be a release cut by the #2222 rule, and package.json to say X;
- requires `npm view instar@X version` to return X. It refuses if the version is absent, and also if npm can't confirm, in which case the message says it is UNKNOWN. It lands only a version already on npm and never runs `npm publish`;
- creates the local tag `vX` if it is missing, and refreshes the gate refs (each from its own remote);
- then runs one of two pushes:
  - **default:** the same atomic push and cut-only rebase rule as step 12;
  - **`--keep-tag-on-published`** prints a note when used, because `vX` is then **not in main's history**. `scripts/release-skip-annotate.mjs` finds the last release with `git describe --tags --match 'v[0-9]*' --abbrev=0`, which sees reachable tags only, so it will treat the previous tag as the last release and report `vX`'s work as unreleased (round 2, item 2). Otherwise: the local tag must be on HEAD (the published commit). It pushes the tag alone, so the tag stays on the commit npm was built from. Then it pushes `HEAD:main`, rebasing the release commit over whatever moved main; the tag does not move. A hook refusal still stops at once, and it never force-pushes. Main then carries the version bump on top of the newer code, as CI's own release commit always does, while the tag marks exactly the published tree.

**Failure semantics.**
- Before publish, any failure restores `package.json`, `package-lock.json` and `upgrades/` (`git checkout HEAD -- …` plus `git clean -fq -- upgrades`). This only ever undoes the script's own edits, because the preflight required a clean tree including untracked files.
- After publish, nothing is undone, and the message says the version is on npm and the release commit must land.
- An UNKNOWN publish state does neither.

**Round 4 — Echo's review of the tool PR (#2225, at 48b54e4f5).** These change the behaviour above as follows:
- **A failure between publish and commit is resumable (blocker).** Publish precedes the smoke test and the commit, as in publish.yml. If the smoke test fails or a pre-commit hook refuses the release commit, the version is on npm and the release cut is still in the working tree, uncommitted. `fail()` now tracks a `committed` flag and, for that case, prints the `--push-only` command plus the exact `git add … && git commit -m "chore: release vX [skip ci]"` alternative. `--push-only` handles that state itself: when the dirty paths are EXACTLY a release cut (the #2222 rule, run on the working tree vs HEAD), HEAD is on `<remote>/main`'s history, and npm has that version, it commits the cut with hooks on and continues to the push. Tests drive both cases through the real CLI against a bare remote: (a) smoke failed, and (b) a pre-commit hook refused (the resume first stops while the hook still refuses, then lands once it is fixed).
- **Registry lag after a failed publish.** `npm view` runs with `--prefer-online`. An "absent" answer is re-queried 3 times, 10 s apart (~30 s). If the publish timed out and npm still says absent, the state is UNKNOWN, not absent. The tree is then kept rather than restored, so the real version can't be orphaned.
- **Classifying a refused push.** Each attempt fetches first, because `--remote` need not be a gate remote. A refused push is classified by ancestry, not by comparing the tracking ref before and after: if HEAD already contains `<remote>/main`, the push was a fast-forward and something refused it (a hook, a permission, or an existing tag). Otherwise main has commits HEAD lacks. Comparing before and after misreads a refusal whenever the tracking ref was stale, or was freshly fetched, which would also have broken "main moved" detection once fetch-first was added.
- **The CI race is named.** If the remote already has `vX` on a different commit, the failure says another publisher (most likely a publish.yml run) released this version. The push is atomic, so nothing was pushed.
- **`--keep-tag-on-published` is resumable.** If the remote already has `vX` at the local tag's commit (a previous run pushed the tag and then the main push was refused after a rebase), it skips the tag push and the tag-on-HEAD check and pushes `HEAD:main` only. Every failure prints the exact re-run command and the by-hand `git push <remote> HEAD:main`.
- **The build** runs with `NODE_ENV=development`, as the install does.

**npm's "Validating" review — an accepted publish is PENDING (added 2026-10-20, after approval, from the first real run).** The first real local release (1.3.1360) had `npm publish` accepted, but the registry returned 404 for 40+ minutes. npm held the version in "Validating" ("Automated review hasn't finished. The version will remain unavailable until review completes."), which only the owner can see, on https://www.npmjs.com/package/instar?activeTab=versions. The smoke step timed out after 15 minutes, and the tool correctly stopped with the `--push-only` resume. The rule:
- An accepted publish that npm does not show yet is **PENDING**: never failed, never re-published.
- When the post-publish smoke test fails, one registry read decides what it means:
  - **not visible** → pending. The message says npm may be holding the version in review, gives the Versions-tab link, says not to publish again, and gives the `--push-only` command to re-run later;
  - **visible** → the published tarball really failed the smoke test.
- `--push-only` keeps refusing while `npm view <name>@<v> version` does not show the version, with the same notice, and never says "Nothing was published". Once npm shows it, `--push-only` proceeds (commits the cut if it is still uncommitted, then pushes).
- `--push-only` cannot tell "accepted, under review" from "never published", because both read absent. So its notice adds: if the version was never published (for example the publish step itself failed), do not use `--push-only`; re-run release-local normally.
- An `unknown` registry answer (npm could not answer) is handled differently on the two paths, on purpose. The smoke path runs only after `npm publish` was accepted, so it counts `unknown` as pending. `--push-only` has no evidence of an accepted upload, so it reports `unknown` as UNKNOWN (`publishUnknown`) and does not claim npm is reviewing the version. Both stop, keep the tree, and never re-publish.

**An unfinished release blocks a new one; `--reconcile <version>` finishes it (added 2026-10-20, after approval, from the 1.3.1362 incident).** instar 1.3.1362 was published (gitHead 7cdc5d571) by a session that never ran `--push-only`, so main stayed at 1.3.1361 until the cut was rebuilt by hand from the tarball (76d5a6098).
- **Preflight:** a real run refuses (a dry run warns) on any of three signals, each naming the version and the remedies (`--push-only` from the worktree that holds the cut, or `--reconcile <version>`):
  - **npm ahead:** `npm view instar version` (latest, with the same npm auth args as `--reconcile`) is ahead of main's package.json. An unreadable answer also stops a real run.
  - **In-flight marker:** this clone has one. That signal does not depend on npm, because npm can hold a version in "Validating" while `npm view` still shows the old latest, which is the 1.3.1362 case (Echo, #2234). The marker is `release-local-inflight.json` in the git common dir, so every worktree of the clone sees it. It is written right before `npm publish` and cleared once main and the tag land (by the main flow, `--push-only` and `--reconcile`). A failure clears it only when this run wrote it and nothing can have reached npm.
  - **Remote tag ahead:** the remote has a `v*` tag ahead of main's package.json.
- **`--reconcile <version>`** rebuilds the cut automatically and never publishes. It requires:
  - a clean tree at `<remote>/main`;
  - the version ahead of main's package.json;
  - npm showing it;
  - its `npm view instar@<v> gitHead` on main's history.
- **The rebuild:**
  - takes `upgrades/<v>.md` verbatim from `npm pack instar@<v>` (the download directory is always removed);
  - deletes the `upgrades/next/*.md` fragments that existed at that gitHead and are still on main, while later fragments are kept. A fragment is deleted only if its blob on main equals its blob at gitHead and its text (every line except the H1 title and comments) appears in the released guide. Otherwise the rebuild stops and names the file;
  - bumps package.json and package-lock.json.
- **Landing:** it then lands the cut exactly like `--push-only`, which re-checks the cut rule, commits with hooks on, and pushes main and the tag atomically. Tests drive it against a bare remote with a fake registry and tarball. Checked against the real 1.3.1362 tarball and gitHead, it produces the same guide and removes the same fragment as the hand rebuild.

**Code layout.** The decisions live in `scripts/lib/release-local-steps.mjs`: `refreshGateBaseRefs`, `pushReleaseAtomically`, `pushTagThenMain`, `isReleaseCutCommit` / `incomingCommits`, `workingTreeReleaseCut`, `headContainsRemoteMain`, `remoteTagSha`, `publishedStateAfterFailure`, `otpRequirement`, `ciRunState` / `activePublishRuns`, `ciGateAction` and `dirtyToolFilesOnly`. Each takes an injected `run(cmd, args)`, so the tests drive real git.

**Docs.** CONTRIBUTING.md gets a "Releasing (maintainers)" section: local release is the default when CI is starved, the three commands, and the differences from CI.

## Decision points touched

- **No agent runtime decision points.** This is maintainer tooling. It is in the npm `files` payload only because `scripts/` is.
- It calls existing release decisions (the release tier, the publish version, the upgrade-guide validation, Stage-B evidence, contract evidence) exactly as publish.yml calls them. It adds no new policy, except fail-closed deviations: `npm view` failing in step 5, a stale gate-base ref in step 0, an unknown publish.yml-run state, and an unknown OTP requirement.
- New deterministic stops on irreversible actions (a publish, a push to main): the preflight checks (including an active or unknown publish.yml run, and an OTP that may be needed with no way to supply it), the hook-refusal stop, the moved-with-code stop, and the UNKNOWN publish stop. All of them stop; none of them block someone else's action. The only override is `--allow-unverified-ci`, which applies to an UNKNOWN run state only; it never overrides an active run.

## Differences from publish.yml (complete list)

| publish.yml | release-local | Why |
|---|---|---|
| `npm publish --provenance` | no `--provenance` | needs CI OIDC |
| `npm view` failure → `0.0.0` | fails closed | locally `0.0.0` lets package.json alone pick the version |
| commit with `HUSKY=0` | commit and push with hooks | hooks are never bypassed (needs #2222) |
| commit push, then a separate tag push | one atomic push of commit + tag | main and the tag cannot disagree (Echo 3b) |
| retry rebases on any push failure | rebases only when the remote main moved, and only over release cuts | a hook refusal is not fixed by rebasing (Echo 3a); a rebase over code would put the tag on a tree npm never got (Echo #2224 item 1) |
| rebase re-tags over any concurrent merge | moved-with-code stops; `--push-only --keep-tag-on-published` keeps the tag on the published commit | the tag must match the tarball |
| tag always in main's history | with `--keep-tag-on-published` the tag is NOT in main's history (a note is printed) | `release-skip-annotate.mjs` reads reachable tags only (`git describe --tags --abbrev=0`), so it would report vX's work as unreleased |
| job skipped for a `[skip ci]` head commit | `[skip ci]` HEAD is a note; the fragment check decides | publish.yml's `if:` stops its own commit re-triggering it; locally there is no loop, and stopping would strand work merged before a cut |
| one run per merge, serialised by `concurrency: publish` | refuses while ANY publish.yml run is unfinished, for any commit | a queued run publishes whatever main is when it starts, so it would race |
| no concurrent-publisher check (concurrency group) | refuses while a publish.yml run for the merge is queued or in progress; unknown → stop | two publishers must never race (open question 1) |
| non-interactive token in CI | OTP decided in preflight; `--otp-command` fresh code at publish; stdin closed | an OTP prompt mid-run would hang after mutating (Echo #2224 item 2) |
| — | `--push-only` resume | a post-publish failure must be resumable without a re-publish (Echo #2224 item 4) |
| a failed `npm publish` fails the job | the registry is asked; published / absent / unknown | npm can fail after the upload landed (Echo 3c) |
| author `github-actions[bot]` | the maintainer's git identity | local run |
| `$GITHUB_STEP_SUMMARY` / `::error::` | stdout | no Actions runtime |
| `actions/checkout ref: main` | requires `HEAD == <remote>/main` (dry run: warns) | the same "release exactly main" property |
| `RELEASE_TOKEN` bypasses branch protection | the maintainer's own bypass permission | same permission, different holder |

## Tests (built)

- `tests/unit/release-local-steps.test.ts` uses real git with a bare remote. It covers:
  - **Pushing:**
    - the atomic first push;
    - a hook refusal, which makes one push, no rebase, and surfaces the hook output;
    - main moved by a **code** commit → stop, with no rebase, main unchanged and no tag pushed;
    - main moved only by another **release cut** → rebase and retry, with the tag following the rebased commit;
    - atomicity: a refused tag leaves the remote main unchanged.
  - **Release-cut detection:** `isReleaseCutCommit` says yes for a cut and no for a code commit, a merge and a root commit.
  - **`--keep-tag-on-published`:**
    - the tag stays on the published commit, and main gets the rebased release commit on top of the code merge;
    - a hook refusal on the main push stops at once;
    - a tag that is not on HEAD is refused.
  - **Gate-ref refresh:** every existing ref is fetched from its **own** remote (the asserted fetches are `origin main` and `upstream main`); a stale `JKHeadley/main` that cannot be fetched → failure.
  - **Pure decision functions:**
    - the three publish-state outcomes;
    - `otpRequirement`: required, not-required, and every unreadable form → unknown;
    - `ciRunState`: every unfinished status (queued, in_progress, waiting, requested, action_required) is active, completed is clear, and an unreadable answer is unknown;
    - `ciGateAction`: unknown stops a real run, an active run cannot be overridden, and a dry run warns.
  - **Wiring:**
    - the gate-ref refresh and the OTP preflight both happen before `npm ci`;
    - the publish.yml check runs in preflight and again just before publish;
    - `npm publish` runs with stdin closed;
    - the push logic gets the capturing runner;
    - `--push-only` checks npm before pushing and never publishes;
    - the UNKNOWN branch neither restores the tree nor says "Nothing was published";
    - the argument guards.
- `tests/unit/release-local-parity.test.ts`: every `node scripts/<x>` in publish.yml is run by the local script, in the same relative order; no hook-bypass or force flags.
- **Mutation-checked.** Each of these mutations made a test fail.
  - Round 1: removing the moved-check, comparing against HEAD, a non-atomic push, skipping a stale ref, treating unknown as absent.
  - Round 2: rebasing over code, counting a merge as a cut, moving the tag in keep-tag mode, dropping the moved-check or the tag-on-HEAD check in keep-tag mode, treating an unknown OTP requirement as not-required (two forms), deciding OTP after `npm ci`, leaving publish stdin open, fetching every ref from `origin`, treating an unknown run state as clear, ignoring in_progress, letting an unknown state proceed, letting an active run be overridden, ignoring the gate action in the script, dropping the pre-publish re-check, skipping the npm check in `--push-only`, and passing the echoing runner to the push.
- **Round 3** (Echo's re-review at 5dc1c8a34):
  - `activePublishRuns`: a run queued for a DIFFERENT (earlier) sha → active; an in-progress run for another sha → active; no query ever carries `--commit`; there is one query per unfinished status; any failed or unreadable query → unknown; all empty → clear.
  - Every queried status is valid for the installed gh.
  - The installed npm's `otplease` rejects a web-OTP `EOTP` at once with stdin closed.
  - `dirtyToolFilesOnly` accepts only the tool's files, refuses package.json, upgrades/, src/, renames and an empty status, and parses a porcelain string whose first line's leading space was trimmed.
  - Wiring: the publish timeout is set; the dry run runs the auth and OTP preflight; a `[skip ci]` HEAD neither stops nor fails; the keep-tag note is printed; `--allow-dirty-tool-files` exits 2 on a real run.
  - 9 more mutations were all caught: adding a `--commit` filter, skipping a failed status query, querying `queued` only, no timeout, stdin open, allowing package.json, an empty status counting as ok, allowing the flag on a real run, and dropping the keep-tag note. Re-adding `pending` is caught by the gh-validity test.
  - 47 tests pass across `release-local-steps` and `release-local-parity`.
- Real data: `gh run list` for the #2222 merge (run 39374587426, `completed`) parses as clear, and `isReleaseCutCommit` says yes for the real v1.3.1359 cut ee72c9c81 and no for merge d1ddf8b4b.
- **Real end-to-end dry run (round 3).** The tool is uncommitted on `feat/release-local-tool`, rebased onto origin/main ee72c9c81, with its own `npm ci`. The command was `node scripts/release-local.mjs --dry-run --allow-dirty-tool-files`, and it exited 0. In order:
  1. It tolerated the 6 tool files and refreshed `origin/main`. HEAD = origin/main = ee72c9c81, a `[skip ci]` cut, which produced the note.
  2. publish.yml: none queued or in progress, for any commit.
  3. npm whoami: would stop (this shell's npm is not logged in). OTP requirement: `unknown` → would stop without `--otp-command` or `--token-skips-otp`.
  4. `npm ci`, then build.
  5. Assemble → NEXT.md has content.
  6. Tier: patch, allow.
  7. npm 1.3.1359 → resolved 1.3.1360.
  8. Renamed NEXT.md → `upgrades/1.3.1360.md`, removing 1 fragment (#2222's).
  9. check-upgrade-guide passed. Stage-B verified 50 deliveries over 120 minutes.
  10. publish.yml re-check: none.
  11. "Would publish instar@1.3.1360". The tree was restored, and only the 6 tool files were dirty afterwards.
- **Two bugs that only the real run could find:**
  - The `pending` status, which made the CI query fail; it was read correctly as UNKNOWN.
  - The dirty-file parser read a trimmed first porcelain line ` M CONTRIBUTING.md` as `ONTRIBUTING.md` and refused it, failing closed.
- Real run (round 1): on a branch, exited 0 (would publish 1.3.1360).

## Multi-machine posture

Machine-local BY DESIGN. One maintainer cuts one release from one workstation against the shared remote. Concurrency with CI or another maintainer is handled the way publish.yml handles it:
- The version is resolved from the registry.
- `npm publish` refuses an existing version.
- It refuses while a publish.yml run for the same merge is queued or in progress, and stops when it can't tell.
- The push is atomic, and it rebases only when main moved, and only over release cuts.
- It never force-pushes.

## Rollback

Delete the script, the npm script and the CONTRIBUTING section. No state, migration or agent surface is involved. A release made with it is an ordinary release: roll back by publishing a new version, as for CI.

## Open questions

*(none)*

## Open items (dated)

- **Auth route before January 2027 (owner: Justin).** npm's banner says tokens that bypass 2FA lose direct publishing in **January 2027**. After that, `--token-skips-otp` with a granular or automation token will no longer publish, and release-local needs another route. The candidates are `--otp-command` with a security key, npm staged packages, or CI trusted publishing (which needs a runner). Choosing the route is Justin's decision; this spec records the date so it is decided before it bites.

## Resolved questions

- **Refuse while a publish.yml run for the same merge is active?** Resolved (Dawn proposed, Echo agreed, #2224 round 1): **yes**, whether the run is queued OR in progress, and print the `gh run cancel` command. If gh can't answer, a real run stops; `--allow-unverified-ci` is the explicit override, and it never overrides an active run. Implemented in step 0, and re-checked before step 10.
- **Direct push to protected `main`, or an auto-merged PR?** Resolved (Dawn proposed, Echo agreed): **direct push is the default.** It is what publish.yml already does with RELEASE_TOKEN; the push gate after #2222 admits only an exact cut; and a PR round-trip would bring back the CI wait this tool exists to avoid. It was proven on 2026-10-20, when the v1.3.1359 cut (ee72c9c81) went straight to main with every hook on.
- **Echo round 1, item 1 (tag vs published tree after a rebase):** her option (b): no rebase over non-release commits. `--push-only --keep-tag-on-published` is the explicit resume path.
- **Echo round 1, item 2 (OTP):** OTP preflight; `--otp-command` for a fresh code at publish time, or `--token-skips-otp` for a granular/automation token; publish stdin closed.
- **Echo round 1, items 3–4:** each ref is fetched from its own remote; a `--push-only` resume exists.
