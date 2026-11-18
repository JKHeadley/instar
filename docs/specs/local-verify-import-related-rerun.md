---
title: "Local Verify: a second try for a failed test that imports changed code, on named main evidence"
slug: local-verify-import-related-rerun
author: echo
status: draft
parent-spec: local-verify-merge-authority
parent-principle: Structure beats Willpower
ships-staged: true
supervision: tier0
eli16-overview: local-verify-import-related-rerun.eli16.md
lessons-engaged: [P1-structure-beats-willpower, P2-signal-vs-authority, P4-testing-integrity, P6-zero-failure, P19-no-unbounded-loops, P21-multi-machine-entity, bounded-blast-radius, fix-the-class-not-the-instance, never-silently-cut-the-data-a-decision-depends-on]
approved: false
review-convergence: "2026-11-18T20:45:40.682Z"
review-iterations: 6
review-completed-at: "2026-11-18T20:45:40.682Z"
review-report: "docs/specs/reports/local-verify-import-related-rerun-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 18
cheap-to-change-tags: 1
contested-then-cleared: 1
---

# A failed test file that imports a changed file may be re-run alone when the same test has already failed and passed on main

Draft v5.1, written 2026-11-18 after review round 6 (the round cap). Not approved. Line numbers refer to `origin/main` at `269f6e532` (release 1.3.1894).

v5 is a cut. Evidence is one thing only: a named test that failed and then passed alone, by name, on a `main` verify. The seed from old audit lines, title-only matching, the file-level fallback and `notCleanOnGreenMain` as evidence are all removed.

**What kind of mechanism this is.** Automatic flaky-test handling with the evidence taken from trunk, the pattern large CI systems use. A hand-kept quarantine list was not chosen: it needs a person to keep it and it goes stale, while trunk evidence is collected by the line itself and expires by itself.

**Glossary.**

- **Verify**: one full run of the test suite on a PR's merge result, or on `main` itself. It ends in a **record** (success, failure or error) that the merge gate reads.
- **Lane**: one of the three parts of a verify (unit, integration, e2e), run at the same time, each with its own deadline.
- **Coordinator**: the machine that owns the queue, keeps the flaky history, decides what is offered and judges `main`.
- **Peer**: a second machine that runs a verify the coordinator hands it and returns the record.
- **Plain file**: a failed test file the PR did not edit and whose import graph reaches nothing the PR changed. One solo run clears it, as today.
- **Import-related file**: a failed test file the PR did not edit, but whose static import graph reaches a file the PR changed.
- **Solo run**: one run of a single test file alone, after its lane has finished (today's "isolation re-run").
- **Detail-only run**: a single solo run of an import-related file in a lane that has already failed. It adds to the failure detail and clears nothing.
- **Main evidence**: a record that a `main` verify, within the last 7 days, saw a named test fail in its lane and pass by name when its file ran alone.
- **Rung**: one step of the rollout (test agent, then development agents, then fleet).

## Problem

Local Verify is the merge-gate test line. When a lane ends with 1 to 3 failed test files and nothing else wrong, the orchestrator re-runs each failed file once, alone. A file that passes alone is cleared and recorded as flaky.

On a PR verify, a failed file is refused that re-run when its static import graph reaches any file the PR changed. For a PR that edits widely imported core modules, that covers nearly every test file. Such a PR gets no re-runs at all, so any flaky test anywhere in the suite fails it.

Evidence from 2026-11-18 (feedback fb-1382c0be-778): PR 3430, a high-priority security fix editing `FileClassifier`, `MachineIdentity`, `GitStateManager` and `PostUpdateMigrator`, failed three verifies in a row, each on a different test file it does not touch. None was re-run. Ordinary PRs hit the same flakes the same day and passed through the re-run (PRs 3346, 3360). Cost: about 75 machine-minutes and several hours of delay.

What `main` had already shown about those three files, read from the Studio's audit log:

| File | Test that failed in PR 3430 | Same file re-run-passed on `main` in the 7 days before | Same test? |
|---|---|---|---|
| `tests/unit/desktop-displays.test.ts` | "reports the main display as current until another is chosen" (`mac-desktop-host-timeout`) | 16 November, the same test and error | yes |
| `tests/unit/CodexCliIntelligenceProvider.test.ts` | "reaps a plain-mode child that ignores SIGTERM before releasing the call" | 16 November, the same test and assertion | yes |
| `tests/unit/job-portable-bundle.test.ts` | reported as `spawnSync python3 ETIMEDOUT`; that run's detail is not in the Studio's log | 16 and 17 November, "updates a full-size owned file and restores it if journal commit fails", assertion errors | not shown; a timeout in a different shape |

**What this spec would have done for PR 3430, said honestly.** On the first day after install: nothing. The evidence store starts empty and none of the three false reds would have been saved. After a week of collection: the two whose same test had flaked on `main` would have been re-run; the third would not. That is the price of evidence that cannot be manufactured, and the review measures it.

## Rule today

Code: `src/localVerify/orchestrator.ts` `ineligibleFor()` (line 809), called at line 692; `src/localVerify/laneReport.ts` `decideIsolationRerun()` (line 251); `isolationRerun()` (orchestrator line 836).

On a PR verify, a failed file is ineligible when any of these holds:

- (a) **Edited.** The PR changed the test file itself.
- (b) **Import-related.** The PR did not change the file, but its static relative-import graph (`localImportGraph`, `src/localVerify/verifierVersion.ts:83`) reaches a file the PR changed.
- (c) **Rule not applicable.** No isolation input, the input says `allowed: false` (this machine holds no green `main` record), the PR's diff could not be read, or no import scan is available.

`decideIsolationRerun` is all-or-nothing per lane: if any failed file in the lane is ineligible, nothing in that lane re-runs (reason `related-to-change`, laneReport line 272). A `main` verify has no ineligible files.

A file in `notCleanOnGreenMain` is not exempt from (a) or (b): the loop logs `isolation-rerun-flaky-on-main` and still applies the import check (orchestrator lines 815 to 822).

Why (b) exists: a regression that reproduces when the file runs alone cannot pass a re-run. But a regression that fails only under a particular order, shared state or concurrent load can pass alone, deterministic or not. Rule (b) guards against a PR that causes exactly that. It is the accepted risk of any solo re-run, and the per-test main evidence below is what narrows it. Said plainly: solo re-runs are used here because that is the existing mechanism's shape, cost and simplicity, not because they detect load-only regressions better. They do not test the in-load condition at all. The named alternative is an in-load retry (vitest's per-test retry for main-listed tests, or re-running the shard). It is not chosen in this change.

**Known limit of the foundation.** The import scan is incomplete and this spec does not repair it. `localImportGraph` (`verifierVersion.ts:83-100`) skips a file it cannot read (line 90), drops a specifier it cannot resolve (lines 70-80), and its one pattern (`SPECIFIER`, line 45) matches only `from '…'`, `import '…'` and `import('…')` with a quoted relative path. It misses `require()`, `vi.mock` and `vi.importActual` paths, template-literal imports and non-relative paths. A dependency it cannot see makes a failed file plain today (one solo run). That is a defect of the existing rule, filed as feedback fb-9b2be76e-79d. This spec cannot make it worse: it only adds eligibility for files the scan DID find import-related.

## Rule proposed

With the switch on, on a PR verify:

1. Each failed file is put in exactly one class, checked in this order:
   - **unavailable**: rule (c). Ineligible, unchanged.
   - **edited**: rule (a). Ineligible, unchanged.
   - **import-related with main evidence**: rule (b) holds, and EVERY test that failed in this lane run for the file is, by full name, in the list of main-flaky tests the coordinator sent for that file.
   - **import-related without**: rule (b) holds and at least one failed test is not on that list. Ineligible, as today.
   - **plain**: everything else. One solo run, unchanged.
2. If any failed file in the lane is ineligible, nothing in the lane re-runs, as today (`related-to-change`).
3. An import-related file with main evidence is re-run alone up to three times. It is cleared only if all three solo runs pass. A solo run passes when today's conditions hold (no failed and at least one passed test, exit status 0, zero unhandled errors) AND every test that failed in the lane run is reported `passed`, by full name, in that solo run. A failed test that is missing, skipped, todo, pending or failed there makes the run not a pass (`failed-test-not-passed`). The first solo run that does not pass ends the sequence: the file failed.
4. Once one file in a lane has failed finally, the lane cannot clear. An import-related file after it in that lane gets one detail-only run. It is kept because it tells the author whether the other failed files look flaky or real without a second verify. A pass there is written into the file's failure detail and nowhere else: the file stays failed, is never added to `flakyRetried`, and nothing is noted in the history. It uses the same budget and deadlines as any solo run (one of the at most 3 files, inside the lane deadline). Plain files after a final failure are handled as today.
5. When an import-related file fails its sequence, the lane report keeps the lane run's counts and message. When it clears, it takes the counts of the last solo run, as today.

Always ineligible under the new rule, each by one line:

- **A file-level failure in the PR run** (an import or hook error, which the parser counts with no failed test, `laneReport.ts:95-98`): there is no name to match.
- **More than 20 failed tests in the file**: a break, not a flake.
- **A failed test whose name is over 300 characters, or that fell off a cut list**: it is not on the list.
- **A renamed test**: renaming edits the file, which is rule (a).

There is no limit on how often one PR can have the same file cleared, and no file-level fallback of any kind.

### The evidence, and how it is collected

The only evidence is: a named test that failed in a lane of a `main` verify and was reported passed by name when its file ran alone in that same verify, within the last 7 days. Runs of other PRs never count: an author could open decoy PRs, stacked and re-opened PRs share commits, and a `main` verify cannot be produced by an unmerged PR. `notCleanOnGreenMain` is not evidence for import-related files; it keeps its existing role for plain files untouched.

One such pass is enough, and the count is one for a reason, not by tuning: it is an existence proof that this test fails without this PR.

**Collecting.** This spec changes what a `main` verify RECORDS, not what it accepts: `main`'s own pass rule (the file passes alone, once) is unchanged. When a `main` solo run passes, the same by-name check is applied to it, and only the names that failed in the lane AND are reported passed in the solo run are recorded as evidence. A file that passes alone on `main` while its failed test was skipped contributes no name.

**What the report carries, and what has to be read.** Each run writes vitest's JSON report, parsed by `parseVitestJson` (`laneReport.ts:56-104`). The report carries per-test results (`assertionResults`), and the parser walks them (lines 76-93), but keeps only counts: it reads each test's `status` and, for the first failing test only, `title` and `failureMessages[0]` (lines 86-91). No test name survives into `FileCounts` (`laneReport.ts:17-28`). The build extends the parser, with no new reporter:

- For failed files only: `failedTests`, each `{ name, line }`, where `name` is the full test name and `line` the first line of its failure message.
- For solo-run reports only: `passedTests` (names).
- The full name is `fullName` when it is a non-empty string, otherwise `ancestorTitles` joined with `title`. **Build check:** confirm on a real report from the pinned vitest that `fullName` is present and that a still-running test is reported as `pending`; the fallback and the existing "unknown status counts as failed" rule cover the case where they are not.
- A name occurring more than once is matched as many times as it failed.
- The names stay in the run child. They are never written to `file-durations.json` or the run result; only the bounded fields in Recording leave the run.

**The store.** `FlakyHistory` (`LocalVerifyService.ts:111-115`) is `files: Record<file, { seen: string[]; escalatedAt: string | null }>`: timestamps only, PR and `main` runs mixed. The entry gains one optional field:

`mainSeen?: Array<{ test: string; at: string; line: string }>`

One entry per distinct test name with its newest time, kept 7 days, at most 40 per file (newest kept). `noteFlaky` (`:3734`) writes it only for a record with `kind: 'main'`, from that record's `soloPassedByName`. Confirmed: the `main` completion path calls `noteFlaky(record)` at `:3462` for every finished `main` verify, and a peer-run `main` verify reaches the same path on the coordinator (`:2404`). When a name is dropped for the cap of 40 or for being over 300 characters, the file is marked `mainSeenCut` (a time, kept 7 days). `seen`, `escalatedAt`, `v: 1` and `decideFlakyEscalation` do not change.

**The first days, said honestly.** There is no seed. Eligibility starts empty and fills as named tests flake on `main`. Measured on the Studio, 10 to 17 November: 8 to 20 `main` verifies a day, of which 2 to 9 carried at least one re-run pass; 34 distinct files re-run-passed on `main` in 7 days. So some tests become eligible within hours, but a particular test only after it next flakes on `main`, which for the incident files was once or twice a week. Expect the full effect after about 7 days.

### Why three, and why no one-clear-per-PR rule

A race the PR introduces typically fails in the lane under load and passes alone, so solo passes prove little by themselves. The protection is the main evidence. The three passes are a second, weaker check resting on a stated assumption: a solo run is lighter than a lane run. As arithmetic for independent trials: a test that fails one solo run in three passes three in a row 30% of the time; one that fails 2% of solo runs passes three 94% of the time; one that fails one in ten still passes three 73% of the time. These figures are illustrative, not measured protection: three consecutive runs on one warm machine are correlated, so the real gain is smaller.

An earlier draft allowed one clear per file per PR. It is not in this spec: with main evidence the test is shown flaky independently of the PR, a second clear in the same PR is the ordinary case for a core PR verified several times, and the rule needed a per-machine memory that a coordinator move lost. Every clear is visible instead (Recording), and the review inspects repeats by hand.

**The remaining risk, stated plainly.** A PR that makes an already-flaky test flakier can clear. Nothing at verify time can tell "flaky as before" from "flakier now". The review's rate on `main` after the PR merged is what catches it.

### What the code does today in a lane that fails anyway

`isolationRerun()` does not stop at the first file that fails again; each later file that passes is pushed to `flakyRetried` (`orchestrator.ts:878-880`). The record carries `flakyRetried` whatever the outcome (`:790`), and the service notes every record, failed or not (`LocalVerifyService.ts:3341`). So a plain re-run pass inside a failed PR run feeds `seen` and the flaky item today. That is unchanged and harmless: PR runs are never evidence here.

### Shape of the code change (for the build, not built here)

- `isolationInput()` (`LocalVerifyService.ts:3796`) returns two more fields: `importRelatedRerun` (the switch) and `flakyOnMain: Array<{ file: string; tests: Array<{ test, at, line }>; namesCut?: true }>` (empty when the switch is off).
- `ineligibleFor()` returns `ineligible` and `importRelated` (import-related, and every lane-failed test on the file's list). Switch off or list empty: the second set is empty and the first is today's result exactly.
- `decideIsolationRerun` takes an optional `importRelated` set and returns the files needing three passes. Its reasons and their order do not change.
- `isolationRerun()` gains an inner loop of 1 or 3 runs per file, the by-name check, and the detail-only mode. Each run computes its own deadline, gets a fresh `TMPDIR` and `TMUX_TMPDIR`, and writes its own report files (`<lane>-rerun-<k>-<n>.json`).
- It imports `boundedTail` and `boundedHead` from `src/core/boundedInput.ts`, which joins the verifier's import graph and hash. Accepted: a later edit to that file re-verifies records once, like any verifier file.
- New constant `LOCAL_VERIFY_LIMITS.isolationRerunImportRelatedPasses = 3` (`src/localVerify/policy.ts`).
- Self-action registry row `local-verify-flake-rerun` (`src/testing/selfActionRegistry.ts:3367`): `perTargetBoundK` 1 → 3 and `boundK` 3 → 9, both derived from the constants; its comment is restated.

## What does not change

- Rules (a) and (c), and an import-related file without main evidence: no re-run.
- A plain file: one solo run, one pass, recorded as today. `notCleanOnGreenMain` and its role for plain files.
- What a `main` verify accepts (plain rule, nothing ineligible).
- The count rules (missing report, file not run, nothing collected, unhandled errors, more than 3 failed files), the cap of 3 files per verify (`policy.ts:58`), the exit-code rule, fail-fast.
- Lane deadlines, the total active deadline, `policyHash` inputs, the import scan.
- With the switch off, PR verdicts, log events and PR record contents are as today. Two things are written whatever the switch says, so that evidence exists when it is turned on: the shared name fields on `flakyRetried` entries and `mainSeen` in the history.

## Switch and how the value travels

**Key.** `monitoring.localVerify.importRelatedRerun`, boolean, default off, read live, following `monitoring.localVerify.mainOnPeers`: declared beside it on the wiring options (`src/localVerify/localVerifyWiring.ts:46-47`), read through `liveConfig.get<boolean>(…, false) === true` (pattern at `:557`), held by the service as a reader with an unreadable switch reading as off (pattern at `LocalVerifyService.ts:1780-1781`), and an awareness entry `src/data/awareness/local-verify-import-related-rerun.md` modelled on `local-verify-main-on-peers.md`.

**To the run child.** The orchestrator runs in a child process and reads neither config nor the history. The service builds the child's input at `LocalVerifyService.ts:3184`: `isolation: entry.peerIsolation ?? this.isolationInput()`. The isolation block becomes `{ allowed, notCleanOnGreenMain, importRelatedRerun, flakyOnMain }`. A local run builds it when it starts, so a queued local entry takes the switch and the list as they are at its start.

**To a peer.** Verified in code:

- The coordinator builds its isolation input at dispatch and sends it with every PR dispatch (`:2204-2207`). It copies two named fields today; both new fields must be added to that copy or they are dropped.
- `parsePeerRunRequest` (`src/localVerify/peer.ts:150-172`) checks `allowed` and `notCleanOnGreenMain` and does not reject other keys inside `isolation`. It is extended: `importRelatedRerun` must be a boolean; `flakyOnMain` an array of at most 200 entries, each with a `file` of 1 to 300 characters, a `tests` array of at most 40 entries (`test` 1 to 300 characters, `at` a timestamp, `line` at most 400 characters) and an optional `namesCut: true`. A body that fails is refused whole.
- The peer stores the block as `peerIsolation` (`:1935`) and uses it for that run (`:3184`). Peer entries are never persisted, a restarted peer tombstones the attempt, and the coordinator always sends `isolation` on a PR dispatch, so the `?? this.isolationInput()` fallback is reached only by local runs.

**Peer safety, two checks.**

1. The peer applies the rule only if its own switch also reads on when it builds the child input. Otherwise it passes the rule off and an empty list.
2. The coordinator checks what the peer cleared against what it offered. It computes the list once, before the attempt's `RemoteMarker` (`peer.ts:18-26`) is created and persisted (`LocalVerifyService.ts:2180`), stores on the marker the file paths and the offered test names for those files (names only, without failure lines: at most 200 files x 40 names x 300 characters, about 2.4 MB worst case per reserved attempt), and sends that same list. The field sits beside `dispatched`, not inside it: `dispatched` is spread into the request body (`:2206`) and the peer refuses unknown top-level keys. A restored marker (`isRemoteMarker`, `:593-601`, used at `:3658`) whose list is missing or malformed reads as empty. `importRefusal()` (`peer.ts:178-202`) gains one check: an entry with `importRelated: true` whose file was not offered, or one of whose `failedTests` names was not offered for that file, returns `import-related-not-offered`. The caller (`:2368-2373`) audits `peer-record-rejected`, abandons the attempt and the PR is verified again. This is a consistency check between two machines on the same build, not a security boundary.

**Verifier hash.** The changed files are in the verifier's import graph, so there is a new `verifierVersion`. A peer refuses a run on a different `verifierVersion` or `policyHash` (`:1896`), so machines on different builds do not exchange runs. The switch and the list are not part of any hash. Records under the old version are re-verified once at boot, as with every verifier change.

## Recording

`FlakyRetry` (`src/localVerify/record.ts:106`) gains two kinds of optional fields.

**Shared fields, allowed on any `flakyRetried` entry of any record (PR or `main`, plain or import-related):**

- `failedTests: string[]`: full names of the tests that failed in the lane run, at most 20, each at most 300 characters. A longer name is left out, never shortened, so a stored name is always the whole name and names are compared exactly.
- `failedTestsTotal: number`: the true count, so a shorter list is disclosed.
- `soloPassedByName: string[]`: the subset of `failedTests` reported passed by name in the solo run (for a three-pass clear: in all three).

**Clearance fields, allowed only with `importRelated: true`:**

- `soloPasses: 3`,
- `soloSeconds: number[]` (three numbers),
- `evidence: Array<{ test, mainAt, mainLine, prLine }>`: for each cleared test, when `main` showed it flaky and the first line of the failure message on `main` and in this PR run. Lines are bounded with `boundedHead(text, 400)` (`src/core/boundedInput.ts:161`), which discloses a cut inside the value. This is the carrier for the by-hand "same test, different failure" comparison.

`validateRecord` (`record.ts:169-176`) rules:

- Shared: `failedTests` at most 20 names of 1 to 300 characters; `failedTestsTotal >= failedTests.length`; `soloPassedByName` a subset of `failedTests`.
- Clearance: refused without `importRelated: true`. With it: `soloPasses === 3`, three `soloSeconds`, `failedTestsTotal === failedTests.length` and at least 1, `soloPassedByName` equal to `failedTests`, and one `evidence` entry per name.

`runDetail` (`LocalVerifyService.ts:132`) already carries `flakyRetried` whole, so the `run-detail` audit line and the routes show all of this, with file and PR, without further change.

**A failed sequence.** `FailureDetail` (`orchestrator.ts:211-218`) keeps `message` and sets `rerunMessage` to `solo run n of 3: …`. The text is bounded with `boundedTail(text, 1000)` (`boundedInput.ts:145`), which keeps the END of the message, where the assertion is, and discloses the cut; the prefix is added after bounding. The bound is 1,000 because the helper's disclosure line is a little over 200 characters and counts inside it. For `failed-test-not-passed` the message names the test and what it was instead (missing, skipped, …). A detail-only run writes `solo run 1 of 1 (detail only, the lane had already failed): passed` or the bounded failure.

Inherited sites this spec does not touch: the bare slices at `laneReport.ts:92` and `:100` and `firstMessage.slice(0, 400)` at `orchestrator.ts:880`. They are not on `docs/bounded-judgment-input-baseline.json` (22 sites, all in files that call a model, none in Local Verify), so nothing tracks them today.

**Run log.** `isolation-rerun` gains, for an import-related file: `importRelated`, `run`, `of`, `detailOnly`, `seconds`, and the outcome `failed-test-not-passed`. `isolation-rerun-ineligible` gains two lists beside `files`: `noMainEvidence` (the file is not on the list at all) and `noMainEvidenceForTest` (the file is on the list but a failed test is not), each entry with the test name and `namesCut: true` when the file's list was cut, so a cut is distinguishable from true absence. The run log is not what the review reads, so both lists also go on the PR's `run-detail` audit line: `noMainEvidence` and `noMainEvidenceForTest`, each at most 10 entries with its true count beside it (`noMainEvidenceCount`, `noMainEvidenceForTestCount`). A PR run that failed writes that line already (`LocalVerifyService.ts:3337-3340`).

**Audit.** No new event for clears; `run-detail` is the carrier. The build adds `finishedAt` to `main-record` and to every `run-detail` line (see the review).

**Existing flaky tracking still applies.** A clear is a `flakyRetried` entry, so it counts in `flakyFiles` and raises `local-verify:flaky:<file>` and its repeat. No new attention signal.

## Limits and worst case

| Number | Status | Basis |
|---|---|---|
| 3 failed files per verify | inherited (`policy.ts:58`) | more than 3 is a real break |
| Lane deadlines 40 / 45 / 60 min, 120 min total | inherited (`policy.ts:36-37`) | hang limits, about twice the measured normal |
| 200 files, 300 characters per path, on the wire | inherited (`peer.ts:160-161`) | the parser's existing refusal thresholds; the coordinator truncates before sending so no run is refused. Longest path under `tests/` today: 98 characters |
| 7-day retention | inherited store bound (`FLAKY_REPEAT`) | older evidence is not stored; the test is then not eligible (today's outcome) and re-enters on its next `main` flake |
| 500 files in the history | inherited store bound (`LocalVerifyService.ts:3777`) | an evicted file is not eligible; it re-enters on its next `main` flake |
| One by-name pass on `main` | new, not tuned | an existence proof that the test fails without this PR |
| Three consecutive solo passes | new | "Why three" |
| 20 failed test names per entry | new | more failing tests in one file is a break, and such a file is ineligible |
| 40 main-flaky names per file, 300 characters per name | new | far above what is seen (one or two names per file today); a cut is marked and only tightens |
| Review thresholds: 10 clears; a rate that at least doubles with at least 3 events after; 1 in 4 | new | enough cases to mean something; three events so one unlucky run cannot trip it |

**Sizes.** History worst case: 500 files x 40 names x about 750 characters (name, time, line) is about 15 MB; today it would be 34 files with one or two names each, a few kilobytes. Wire worst case: 200 files x 40 names x about 750 characters is about 6 MB, under the server's 12 MB body limit (`AgentServer.ts:2048`). The counts above are in characters, and a body limit is in bytes, so the coordinator also bounds the serialized isolation input by UTF-8 byte length: 8 MB, which with the rest of the request stays under the 12 MB limit. Over it, evidence entries are dropped oldest first, the affected files are marked `namesCut`, and the cut is logged in the same audit line as below. That only tightens. The parser REFUSES an over-long list today (`peer.ts:158-162`), so the coordinator bounds the list when it builds it: over 200 files it keeps the 200 with the newest evidence and logs the cut (audit `flaky-on-main-bounded`).

**Budget and time.** An import-related file counts as one file against the cap of 3, so a verify has at most 3 re-run files and at most 9 solo runs (today 3). Each solo run's deadline is what is left of its lane's deadline or of the total, whichever is smaller (`orchestrator.ts:845`). A solo run that cannot start or hits the deadline counts as failed, as today, so a file whose three runs do not fit is failed, with its own outcome `deadline` in the run log and the failure detail (`solo run n of 3: not finished inside the lane deadline`), so it is not read as a test failure. No deadline moves.

**Worst-case added minutes.** The most this can add to a lane is the gap between its normal end and its deadline: about 21 minutes for unit (about 19 of 40 used, `policy.ts:33-35`), about 40 for e2e (11 and 20 of 60, `policy.ts:60-63`), reached only if a solo run hangs. The expected cost is two extra solo runs per cleared file; `soloSeconds` records the real figure from the first run on. The suite slot is held for the whole lane phase, so this is extra slot time.

## Failure modes

Loss of state only tightens. There is no fallback that a missing list or a missing name could switch on: without a named test on the list, the file is ineligible, which is today's outcome.

| What goes wrong | What happens |
|---|---|
| Switch unreadable, or `importRelatedRerun` absent in the child input | Off. Today's rule. |
| Flaky history missing or unreadable | Empty history (`LocalVerifyService.ts:3766-3772`); `allowed` is false and nothing re-runs, as today. |
| No `mainSeen` yet, or the coordinator role moved to a machine with a thinner history | Fewer or no tests on the list. Stricter. |
| A name was dropped by a cap or the length bound | Not on the list; ineligible; logged with `namesCut`. |
| Coordinator on and peer off, or the reverse | Today's rule on that run. |
| A peer returns a clear that was not offered, or the restored marker has no list | `import-related-not-offered`; not imported; verified again. |
| Import scan missing, throwing, or blind to a dependency | Unchanged from today (fb-9b2be76e-79d). |
| A regression that reproduces when the file runs alone | Without evidence: no re-run. With it: fails a solo run. |
| A regression that needs order, shared state or load, in a test `main` has shown flaky | It can pass three solo runs and merge. Accepted and stated; the review's rate is the check. |
| A PR makes an already-flaky test flakier | Same: it can clear. Visible in the record; the review's rate is the check. |
| A solo run is green but did not run the failed test | Not a pass (`failed-test-not-passed`). |
| Same test, different failure than on `main` | It can clear. `evidence` carries both first lines; read by hand at the review. |
| A test name generated from data (`it.each`) | It matches only when the generated name is identical. Names that collide across different cases are on the hand-read list. |
| The evidence is stale (the flake was fixed on `main` five days ago) | The test stays eligible up to 7 days. Accepted. Dropping a test after N clean `main` runs is not built: clean runs write no per-file line today, and the review's rate decides whether it is needed. |
| The two-step path: merge a PR that makes a test flaky on `main`, then use that evidence | Possible. It costs a merged, attributable flaky commit on `main` that every other PR also hits. On the hand-read list. |
| A solo run hangs, or another lane fails finally during the solo runs | Counts as failed, as today. |
| Peer on an older build | Refuses the run (`verifier-mismatch`). |

## Tests

All three tiers, per the Testing Integrity Standard.

**Unit**

- `tests/unit/localVerify/laneReport.test.ts`: the parser returns `failedTests` (name and first line) for failed files only and `passedTests` for solo reports only, by `fullName` and by the fallback; `pending` and unknown statuses are failed names; every existing count is unchanged. Direct `decideIsolationRerun` cases (none exist today): import-related with evidence → eligible with three passes; ineligible present → `related-to-change`; mixed with plain; budget; more than 3 files; `importRelated` absent → today's result.
- `tests/unit/localVerify/orchestrator.test.ts`, extending the blocks at lines 916 and 982:
  - switch off: the case at line 992 passes unchanged, with the same log events, also when the file is listed;
  - every failed test on the list, three by-name passes → `success`, with the shared and clearance fields; exactly three extra vitest calls;
  - a failed test not on the list → no re-run, `noMainEvidenceForTest`; two failed, one on the list → no re-run; file not listed → `noMainEvidence`; a cut list → the entry carries `namesCut`;
  - a file-level PR failure → no re-run, also when the file is listed; more than 20 failed tests → no re-run;
  - three runs that do not fit the lane deadline → failed with outcome `deadline`; pass then fail → `failure`, two extra calls, `rerunMessage` starts `solo run 2 of 3:`; a long message keeps its end with the disclosure;
  - a green solo run in which the failed test is skipped, or missing, or replaced by another passing test → `failed-test-not-passed`; a duplicated name needs as many passes as failures;
  - **detail-only pin:** two eligible files, the first fails; the second gets exactly one solo run, which passes; it is not in `flakyRetried`, its detail says `detail only … passed`, it is still failed, and it counted against the budget;
  - a plain file after a final failure is still re-run and pushed to `flakyRetried` (pins today);
  - edited file, `allowed: false`, a `notCleanOnGreenMain` file that imports a changed file and has no named evidence → no re-run with both switch values; a `notCleanOnGreenMain` file with no import relation → one pass (line 1004);
  - a scan that throws → plain (pins today); deadline, unhandled error, fail-fast stop → failed;
  - **collection:** a `main` solo pass records in `soloPassedByName` only the names that failed in the lane and passed by name; a `main` solo pass with the failed test skipped still clears `main` (its rule is unchanged) and records no name.
- `tests/unit/localVerify/peerVerifier.test.ts` (lines 62-68, 1255): the parser accepts the new fields and refuses each malformed shape and each bound; the dispatch carries the list and the marker holds the same files and names, set before it is persisted; peer switch off → rule off and empty list in the child input; `importRefusal` accepts an offered clear and refuses an unoffered file, an unoffered test name, and any clear when the marker has no valid list.
- `tests/unit/localVerify/mainHealth.test.ts` (lines 821-830): the child input's `isolation` has the new fields, following the live switch.
- `tests/unit/localVerify/record.test.ts`: one test for the shared-field rules and one for the clearance-field rules, each with its refusals.
- `tests/unit/localVerify/LocalVerifyService.test.ts`: a `main` record writes `mainSeen` from `soloPassedByName`, a PR record does not; one name per test with the newest time; 7-day trim; the cap of 40 and the length bound set `mainSeenCut`; the list is built from `mainSeen` only (never from `notCleanOnGreenMain` or `seen`); switch off → empty list; over 200 files → cut and audited; an isolation input over 8 MB in UTF-8 bytes (multi-byte test names) drops the oldest evidence, marks `namesCut` and audits the cut; `seen` and the repeat escalation unchanged; the refusal lists and their counts are on the PR `run-detail` line; **carrier pin:** a successful `main` verify with a non-empty `flakyRetried` writes a `run-detail` line and a clean one writes none (the condition at `:3461`); `finishedAt` is on `main-record` and `run-detail`.
- `tests/unit/self-action-convergence.test.ts`, `tests/unit/lint-no-unregistered-self-action.test.ts`: pass with the amended registry row.

**Integration**

- `tests/integration/local-verify-routes.test.ts` (line 421): a record with a clear appears in status and run detail with the new fields.
- `tests/integration/local-verify-peer-routes.test.ts`: a peer-run request with the new fields is accepted over HTTP; a malformed one is refused.

**E2E**

- `tests/e2e/local-verify-lifecycle.test.ts`: on the production init path, the live key and a list computed from a real history file reach the run child's input, with the key off and on.

## Maturation plan

The detail of each rung and the review rule is in the next section; this is the summary the maturation gate reads.

- **test-agent-live:** a throwaway agent runs supervised verifies of a fixture PR with the switch on, six cases end to end (clear after three by-name solo passes; failure on the second solo run; test not on main's list stays ineligible; file-level PR failure stays ineligible; peer with its own switch off ignores the rule; record with an unoffered clear is refused).
- **dev-agent-live:** development-class agents running Local Verify, switched on by the owner after the test-agent rung, on all machines of such an agent once all carry the build; for this repository that is the full effect, because the development agent's verify gates every merge.
- **fleet:** stays off; proposed to the operator only by the day-7 review, and only together with a recurring check that drops a file's main evidence when its main rate at least doubles after a clear.
- **graduation criterion:** from the audit log over the 7 days after the dev-agent rung: at least 10 clears, no cleared file whose rate on main at least doubles with at least 3 events after the clearing PR merged, and clears making up at least 1 in 4 of all import-related failures; a doubling case is read by the owner the same day and the switch goes off unless the cause is clearly elsewhere.
- **dark-window:** off by default everywhere from the release that carries it; the fleet stays off until the operator decides on the review's proposal, with the review written on day 7 after the dev-agent rung starts.
- **ladder:** monitoring.localVerify.importRelatedRerun

## Maturation and rollback

**Owner.** The throughput session of the Echo agent (`echo-increasing-throughput`) builds this, runs rung 1, turns rung 2 on, runs the review and writes the result.

- Ships dark: default off for everyone.
- **Rung 1, supervised test agent.** On a throwaway agent, supervised verifies of a fixture PR with the switch on, six cases end to end:
  1. a failed test on main's list clears after three by-name solo passes;
  2. it fails its second solo run and the verify fails;
  3. a failed test that is not on main's list stays ineligible;
  4. a file-level PR failure stays ineligible;
  5. a peer with its own switch off ignores the rule;
  6. a returned record with an unoffered clear is refused.
- **Rung 2, development-class agents running Local Verify.** Switched on by the owner after rung 1, on all machines of such an agent once all carry the build. Said honestly: for this repository rung 2 is the full effect, because the development agent's verify gates every merge to `main`.
- **Rung 3, fleet.** Proposed to the operator only by the review.

**Review on day 7 after rung 2, by this written rule.**

- *Carrier.* The audit log (`logs/local-verify.jsonl`, `LocalVerifyService.ts:936`), not the capped history. Clears: PR `run-detail` lines with `importRelated: true`. `main` events: `run-detail` lines with `kind: 'main'`. The count of `main` verifies: `main-record` lines (`:3436`), because a clean green `main` verify writes no `run-detail` line (`:3461`).
- *Retention, checked.* 5 MB x 10 files (`policy.ts:81-82`). On the Studio three files cover 22 October to 18 November, so 14 days are available.
- *One verify, counted once.* Each `main` verify is completed on one machine, the coordinator at that moment. A peer that ran it also writes a replica marked `source: 'peer-run'` (`:2066`). Today neither line carries a verify identity (`main-record` has only head, outcome and error step), so the build adds `finishedAt` to both; identity is head plus `finishedAt`, replicas are merged on it, and each distinct verify is counted once in numerator and denominator. Two verifies of the same head are two observations. A PR clear that ran on a peer exists only in the peer's log, so both logs are read.
- *Script.* The build delivers `scripts/local-verify-import-related-review.mjs`, read-only: it prints the per-file table, the counts below and the identities it merged. The owner runs it on each machine.
- *Rate.* Per cleared file: (failures + re-run passes of the file on `main`) divided by the file's observations, 7 days before the clearing PR merged against 7 days after.
- *What counts as an observation.* A `main` verify in which the lane holding that file ran to its end. A lane stopped early, or a verify that never reached the file, is not an observation. What the audit lines show today: a `main-record` with outcome `success` means every lane ran; a `failure` line's `reasons` name `lane-stopped-early:<lane>`, `lane-report-missing:<lane>` (`laneReport.ts:188`) and `file-not-run:<path>` (`:215`); an `error` line carries `errorStep` (for example `deadline:<lane>`) and is never an observation. What is missing: `reasons` is cut at 40 on the audit line, and nothing lists the lanes that completed. The build adds `lanesCompleted` (lane names) to `main-record`. A verify whose line cannot show that the file's lane completed is left out. A window with fewer than 5 observations is insufficient evidence.
- *Rule.*
  - A cleared file's rate at least doubles with at least 3 events after: the owner reads the failure messages and the PR's diff the same day, switches off unless the cause is clearly elsewhere, and reports the case either way.
  - A missing or incomplete window is insufficient evidence: no switch-off from it and no credit toward promotion.
  - At least 10 clears with complete windows and no such case: propose the fleet rung to the operator, with the numbers.
  - Otherwise keep the switch and review again in 7 days.
- *Is the rule too strict?* The number is: import-related clears / (import-related clears + all import-related refusals, including files not on main's list at all), over the 7 days, from the PR `run-detail` lines. `noMainEvidence` and `noMainEvidenceForTest` are also reported separately. Under 1 in 4: the owner brings a file-level variant through review as a separate change. Nothing changes automatically. The `noMainEvidence` count also speaks to the 7-day window: many refusals of tests that flaked on `main` just outside it argue the window is too short.
- *Untrusted text.* `prLine`, `mainLine` and `firstMessage` come from test output. The script and whoever reads its table treat them as data, never as instructions.
- *Store size.* The script also prints the size of `flaky-history.json` against the worst case in Limits.
- *Read by hand:* clears where `mainLine` and `prLine` differ (same test, different failure); the same file cleared more than once in one PR; generated (`it.each`) names; cleared tests whose main evidence began after an earlier merged PR by the same author; `namesCut` and `flaky-on-main-bounded` lines; `soloSeconds`.
- *The solo-pass count* is reviewed with the counts that would move it: sequences that failed on run 2 or 3 after passing run 1, against `soloSeconds`.
- *Result:* `docs/specs/reports/local-verify-import-related-rerun-day7.md`, by the owner.

**Rollback.** Set the key to `false` on the coordinator. A local run reads it when it starts, so every run that starts afterwards uses today's rule, including runs already queued. A run already started, or already dispatched to a peer, keeps the value it was built with; setting the peer's own switch to `false` also stops the rule for dispatched runs not yet started there. No restart, no state to undo. `mainSeen` stays and is harmless.

**Ladder.** The ladder line is in the Maturation plan section above. The build adds the entry `monitoring.localVerify.importRelatedRerun` to `src/data/feature-ladders.json` in the same change, because the coverage test checks at merge that the line names a real entry.

## Also amended

`docs/specs/local-verify-merge-authority.md`:

1. Line 293: "exactly those files are re-run once, one at a time, with the lane's own config, env and flags, under what is left of the lane budget; the cap of 3 covers the whole verify." Becomes: once, or three times for an import-related file whose failed tests `main` has shown flaky; the cap counts files.
2. Line 293: "A real, order-dependent failure must not pass as a flake, so on a PR verify a failed file is never re-run (it is a real failure) when the PR changed it, when it imports a file the PR changed (static relative-import scan, the same graph helper the verifier version uses), when this machine holds no green `main` record, or when that record shows the file did not pass cleanly there (it was itself re-run-passed); `main` verifies keep the plain rule." The clause "when it imports a file the PR changed" gains the exception. (Its last clause was already superseded by line 307.)
3. Line 293: "A file that passes is recorded in `record.flakyRetried` (`{file, lane, firstMessage}`) and the lane counts as passing, so the outcome stays `success`; a file that fails again is a real failure carrying both messages;" The entry shape gains the fields in Recording.
4. Line 293: "a re-run that hits the lane deadline counts as failing again." Stays true; all three runs must fit.
5. Line 307: "The rule that protects against a real failure passing as a flake is unchanged: on a PR verify a failed file is still never re-run when the PR changed it or a file it imports, or when this machine holds no green `main` record;" "or a file it imports" gains the exception.

Line 140 and line 307's "(2) A file flaky on `main` gets its one re-run" stay true as written.

`src/data/state-coherence-registry.json`, category `local-verify-flaky` (lines 2144-2158): the description gains "and, per file, up to 40 test names a `main` verify saw fail and pass alone, each with its time and first failure line". The retention note becomes "At most 500 files (newest kept), each with at most 20 timestamps inside a 7-day window and at most 40 main-flaky test names inside the same window, plus one green-main entry; rewritten in place." `scope: machine-local`, `conflictShape: single-writer`, `transport: none`, `maxRecords: 501` stay.

Code comments that state the rule: `laneReport.ts:241-250`, `orchestrator.ts:181-186`, `:801-808`, `:829-835`, `policy.ts:53-57`, `record.ts:68-73`, `LocalVerifyService.ts:111-115` and `:3795`, `src/testing/selfActionRegistry.ts:3358-3366`.

## Decision points touched

- (a) Classing a failed test file — invariant; basis: enumerable-domain; evidence: the class is a function of enumerable facts the run holds (the PR edited the file; its import graph reaches a changed file; the rule's inputs are unavailable; the switch value; each lane-failed test name is or is not on the list received). Each combination maps to one class. Nothing is weighed.
- (b) What clears an eligible import-related file — judgment-candidate, with the floor stated: bounded actions (at most 3 files and 9 solo runs per verify), conservative default (switch off, name not on the list, a failed test not reported passed by name, or any solo failure = today's result or a failure), and a deterministic last rung ("the file failed"). The discriminating inputs are facts, not counts: the same named test failed and passed by name on `main`, which no unmerged PR can produce, and that named test is seen passing in each solo run. No run-time model arbitrates: the decision must come out the same on the coordinator and on a peer from the same input, and be auditable from the record alone. Repeated clears in one PR are not gated: a repaired revision no longer fails the test and needs no clear. The arbiter of the solo-pass count, and of whether per-test strictness is too strict, is the day-7 review, with a written rule and a named owner.

## Multi-machine posture

- **No new store.** The rule reads the coordinator's flaky history (`flaky-history.json`), which the state-coherence registry already declares machine-local (`src/data/state-coherence-registry.json`, lines 2144-2158, `grandfathered: false`). `mainSeen` is a field in it with the same role as `greenMain.notClean` in the same file, which already gates re-run eligibility per machine. It rebuilds from each machine's own observations. No new surface, no new marker.
- **One machine computes, the result travels.** The coordinator computes the list and sends it with the switch inside `isolation`. A peer never computes a list for a dispatched run.
- **Loss of state only tightens.** A missing, unreadable, thinner or cut history means fewer names on the list, and a test not on the list is ineligible, as today. No fallback exists that missing state could switch on.
- **Both switches must agree for a peer run,** and the coordinator refuses to import a clear it did not offer.
- **Builds.** Machines on different builds do not exchange runs.
- **One voice.** No new notice or attention item. The review reads both machines' audit logs.

## Frontloaded Decisions

1. **Evidence is a named test on `main`, nothing else.** A file is eligible only if every test that failed in the PR's lane run is on the coordinator's list of tests that failed in a lane and passed alone by name on a `main` verify in the last 7 days. No seed, no title matching, no file-level fallback, no `notCleanOnGreenMain` as evidence. Decided at review round 5.
2. **One by-name pass on `main` is the threshold,** as an existence proof, not a tuned number.
3. **`main` collection uses the same by-name check;** what `main` accepts is unchanged.
4. **Three consecutive solo passes, each by name,** as a second check. Changed only by the review.
5. **No one-clear-per-PR rule.** Repeats are visible and read by hand.
6. **The history entry gains `mainSeen`** (`{ test, at, line }`, at most 40 per file, 7 days), written for `main` records whatever the switch says. No other state.
7. **Peer safety.** The peer needs its own switch on; the coordinator computes the list once before the marker is persisted, keeps files and names on the marker outside `dispatched`, and `importRefusal` rejects an unoffered file or test. A consistency check, not a security boundary. The `?? this.isolationInput()` fallback is reached only by local runs.
8. **Ladder entry: yes.** The build adds `monitoring.localVerify.importRelatedRerun` to `src/data/feature-ladders.json` (risk `sensitive`, rung `dev-agent-live` with the review rule, final state opt-in until the review proposes otherwise) and the ladder line in the same commit.
9. **The import scan is not changed** (fb-9b2be76e-79d).
10. **Lane-wide all-or-nothing stays.**
11. **The detail-only run is kept,** shares the budget and deadlines, and a pass there is never a flaky record.
12. **Recording.** Shared fields on any entry; clearance fields only with `importRelated`; names are stored whole or not at all; lines and messages are bounded with `boundedHead` / `boundedTail`, which disclose the cut. `boundedInput.ts` joining the verifier hash is accepted.
13. **No new attention signal, no new audit event for clears.** `finishedAt` is added to `main-record` and `run-detail`.
14. **Self-action registry:** per target 1 → 3, per verify 3 → 9.
15. **Solo re-run, not a re-run in lane context.**
16. **Stale evidence is accepted for now.**
17. **The review reads the audit logs of both machines through one script,** counts each verify once, and reports `noMainEvidenceForTest` separately with the 1-in-4 rule.
18. **Test names stay in the run child** apart from the bounded record fields.

## Left behind

Accepted at the round cap. None is a security or data-loss finding.

- **No automatic trip after the day-7 review.** A test that a merged PR made flakier renews its own main evidence. Accepted for the two dark rungs because the rule is off by default, the owner runs the review, and every clear is in the audit log. It is a named condition for any fleet rung: the proposal to the operator must include a recurring check that drops a file's main evidence and raises the existing flaky attention item when its main rate at least doubles after a clear.
- **Solo re-runs do not test the in-load condition.** Fixed in wording only. The in-load retry goes to the throughput session's queue as a follow-up spec if the review shows clears followed by `main` failures of the same test.
- **Rate denominator and byte bound.** Fixed in text in this last edit and not re-reviewed. The build's second-pass reviewer is asked to check both specifically.
- **Refusal-count carrier.** Fixed in text in this last edit and not re-reviewed; same request to the second-pass reviewer.
- **Fixed limits the standards gate keeps flagging** (three passes; 3 files; the 7-day, 20, 40 and 500 store bounds; the 200 and 300 request bounds; the 20-test ceiling). Each is inherited or tighten-only, has its basis in Limits, and is reviewable at day 7.
- **Import-scan blind spots of the existing rule.** Filed as fb-9b2be76e-79d; not changed here.

## Open questions

*(none)*
