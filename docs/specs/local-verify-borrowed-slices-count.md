---
title: "Local Verify: borrowed machines take slices of the slow tests, and their results count after practice"
slug: "local-verify-borrowed-slices-count"
author: "echo"
parent-principle: "A Safeguard Must Leave a Benefit"
parent-spec: "docs/specs/local-verify-borrowed-unit-slices.md"
eli16-overview: "docs/specs/local-verify-borrowed-slices-count.eli16.md"
tier: 2
supervision: tier0
topic: 145097
depends-on: "PR 3473 (the parent article) and PR 3471 (unit durations and the ladder entry) merged"
approved: true
approved-by: "Chief of Staff (echo-chief-of-staff), 2026-11-18 22:27 PT (agent message 33c58e59), both items by name: borrowed passing results may feed the merge decision after the stated evidence and a recorded per-lane decision; reversal of the scan-as-hard-floor fold-in. Conditions: constitution check on the final text folded in; no host mount and no host secrets as a tested property; nothing on Justin's machines before his yes for each"
cross-model-review: "codex-cli:gpt-6.2-astra"
review-convergence: "2026-11-19T06:24:24.639Z"
review-iterations: 6
review-completed-at: "2026-11-19T06:24:24.639Z"
review-report: "docs/specs/reports/local-verify-borrowed-slices-count-convergence.md"
cross-model-review: "codex-cli:gpt-6.2-astra"
---

# Local Verify: borrowed machines take slices of the slow tests, and their results count after practice

This document amends `docs/specs/local-verify-borrowed-unit-slices.md`, called "the first design" below. It is written to be read alone. Where it relies on the first design, it says in a few lines what that part does and names the section for the detail.

## Words used here

- **Change:** a pull request, waiting to be merged into `main`, the shared code.
- **Local Verify, "the line":** the system that tests every change before it may merge.
- **Run machine:** one of our own two computers that run Local Verify: the Studio and the M5. The Studio is also the **coordinator**: it decides which machine tests which change, and it accepts the M5's results (a **peer run**).
- **Verify:** one test run of one change. The run machine tests the change merged with the current `main` (the **merge tree**), not the change alone.
- **Main verify:** a test run of `main` itself, after changes have merged. It usually covers several merges at once and comes a few hours apart (about 8 a day on the Studio). If it fails, the **main-red hold** stops further merges until `main` is repaired.
- **Lane:** one of the three groups of tests in a verify: unit (quick), integration (slower) and end-to-end. Lanes run side by side, so a verify is as long as its slowest lane.
- **Shard:** one of the processes a lane is split across. The Studio runs integration in 2 shards.
- **Helper:** a borrowed machine: the owner's laptop or his Windows PC. Each already runs an Instar agent.
- **Sandbox:** a sealed Linux virtual machine on the helper. Every build and test on a helper runs inside it.
- **Slice:** a set of test files from one lane, sent to a helper.
- **Practice:** the helper runs slices and the run machine runs the same files. The answers are compared and the helper's are never used.
- **Counting:** the run machine accepts the helper's passing result for a file and does not run that file itself.
- **Hand-back:** the helper stops a slice because its owner needs the machine, and returns the unfinished files.
- **The throughput session:** the agent session that operates the line. Only it changes settings on the run machines.

## Problem

**What the owner asked for.** Justin asked (topic 130715, messages 143933, 143942, 143952 and 142464) for a system that uses spare capacity on other machines he owns, starting with his laptop and an old Windows PC. It must work while he uses the machine and pull back when he needs it.

**The first design, and what was wrong with it.** It was approved on 2026-11-18. Justin read it that day and wrote (topic 145097, message 145401): "it sounds like it might be too restrictive (not sure though). I want to make sure we don't fall into the trap of overengineering or being over-secure to the point where we get no benefit from the plan." On review, four of its restrictions did remove the benefit:

| Restriction in the first design | What it cost |
|---|---|
| Practice only, with no end stated | All of the benefit, until a later, separate design |
| Unit tests only | Nearly all of it. Unit is not the slowest lane on either run machine |
| Only code already merged | All help for changes that are waiting, which is the work that matters |
| 20 practice runs on the laptop, then by default the Windows PC, then a new design, then another yes | Weeks |

**What we measured since (2026-11-18, evening).** After Justin's yes, the laptop ran the integration tests once inside the sandbox, on merged code, one file at a time:

- The 966 integration files that ran on all three machines took 1,147 seconds of test time on the laptop, 2,275 on the M5 and 2,890 on the Studio. The M5 and Studio figures come from real verifies with other lanes running beside them, and the laptop ran alone, so the true gap is smaller. This shows the laptop completes the work in a useful time. It does not show how it compares under equal load.
- 963 of the 966 passed. 57 of them need a network interface other than loopback (the machine's address for talking to itself) to exist; a private dummy interface that reaches nothing satisfies them. Three files in one area (the recovery installer) fail in a plain Linux box.

**Where a verify's time goes (same day):**

| Run machine | Unit | Integration | End-to-end | Whole verify |
|---|---|---|---|---|
| Studio | 22.7 min | 36 min | 28 min | about 38 min |
| M5 (integration in 3 shards) | 15.4 | 17.8 | 15.0 | 19.3 min |

The Studio's integration lane is the slowest thing on the line, and it is the lane the laptop is measured on. Giving the Studio a third integration shard is not the cheaper route: its lanes already starve each other (a 3-shard experiment on 2026-11-13 was rolled back to 2).

## What this amendment changes

1. A helper may take slices of **any lane** it has practised on. It starts with integration, because that is measured.
2. Practice has an end, stated as evidence (below). After it, the helper's passing results **count**.
3. A helper runs **our own waiting changes**, in practice and in counting, once a dry run on merged code has shown its sandbox works.
4. The laptop and the Windows PC go through this **in parallel**, each paired with one run machine.

Two restrictions of the first design stay as they are, because they protect the owner and cost almost nothing: tests run only inside the sandbox, and the helper backs off whenever its owner needs the machine.

**Three separate authorities.** They are kept apart so that none is read as another:

- **The owner's yes** is consent to how his machine is used: the sandbox, our waiting changes running inside it, and its answers being used. It is asked once per machine.
- **Approval of this design** (review and the Chief of Staff, the agent session that approves designs) is what allows a borrowed result to feed the merge decision.
- **The decision to start counting** for a helper is the throughput session's, taken on the practice report.

## Every restriction that remains: what it protects and what it costs

| Restriction | What it protects | What it costs | Verdict |
|---|---|---|---|
| Tests run only inside the sandbox: no view of the owner's files, fixed memory and CPU, no network for tests | The owner's files, passwords, memory and home network | Measured: integration tests run at full speed inside it. Three files do not pass there | Keep |
| The helper stops when the owner is busy, on battery or short of memory | The owner's own work | Helper time, only while he needs the machine | Keep |
| The run machine runs any file the helper has not finished | The line never waits on a helper | One extra process start per shard, in the worst case | Keep |
| Both sides test the same merge tree, proven by its hash | A pass for different code than the verdict is about | One git command on the helper per preparation | Keep |
| A dry run on merged code before any waiting change runs on a helper | Waiting changes never run in a sandbox that has not been shown to work on that machine | One pass of each lane, a few hours of helper time | Keep |
| One verify in ten, chosen at random, holds nothing back | Fresh timings, same-code comparisons that can catch a wrong helper, and an honest measure of the gain | A tenth of the gain | Keep |
| Practice before counting, ended by evidence | A helper that reports wrong results, found before anything depends on it | About a week per helper and lane (an estimate); decided at the 7-day review on whatever was collected | Keep |
| A pass counts only with no failures and the same skipped tests our own machines see | Tests silently not running anywhere | Files that skip differently on Linux stay on the run machine | Keep |
| A failure from a helper is not used; the run machine runs the file | A change refused because a borrowed machine differs from ours | The file's own run time | Keep |
| One check slice with known answers per verify, and a re-run of 1 in 20 of the helper's passed files on the run machine | A helper that reports a pass for a test that fails | About 5% of the helper's gain; the re-runs may add a few tens of seconds | Keep |
| A confirmed wrong pass fails that verify on our own machine's result, and can return the helper to practice | Trusting a helper after it was wrong | Rare by design: a single flaky test does not trigger it. Expected rate unknown until practice measures it. Green results that used that helper's earlier passes stay valid; this is an accepted residual, checked only by later main verifies | Keep |
| Main verifies never count a helper's results | The safety net stays independent of helpers | Main verifies get no speed-up (about 19% of the Studio's day) | Keep |
| Only changes from branches inside our own repository | A stranger's code on the owner's machine | Nothing today: every waiting change is from our own branches | Keep |
| Packages are installed only from merged code, and only when the change leaves the install inputs as they are on `main` | New packages, or a change's own install steps, running with internet access on the owner's machine | A change that edits the package list, `package.json` or an install script gets no help. Measured: 0 of the last 150 merged changes changed the package list; edits to `package.json` are not yet counted | Keep |
| One helper serves one run machine | A simple queue on the helper and one place for its practice record | A helper idle on its side while the other run machine could use it | Keep for now; revisit at the 7-day review |
| A helper's share of a lane starts at a quarter, then follows its measured speed and how free it says it is | Sending more than the helper finishes, which only adds take-back work | A slower ramp over the first 5 verifies | Keep; starting value, adjusted by measurement |
| A lane needs its own practice | Counting on a lane the helper was never compared on | End-to-end help comes later than integration help | Keep |
| A learned list: files that keep failing on a helper are not sent to it | Wasted helper time and noisy comparisons | Those files get no help (3 known on the laptop) | Keep |
| Mac-only tests are never sent (desktop helper, Chrome, the Codex CLI, launchd, tmux) | Wasted helper time on tests that cannot pass in this Linux sandbox | Nothing: they cannot pass there | Keep |
| The first design's word scan, which kept test files off helpers | The same thing the sandbox already protects | In the first design it kept about 80% of unit files off helpers | **Becomes a recorded note. It no longer blocks** |
| The first design's back-off for a silent helper (up to 8 hours) | Almost nothing: asking a helper costs one short request | A laptop that wakes up is ignored for hours | **Replaced.** A silent helper is asked less often, and a helper that wakes says so and is used on the next verify |

## The benefit that survives

Stated as a range, from the Studio's own run logs, with what is and is not measured.

**Measured, 2026-11-15 to 11-18, on the Studio.** It ran 31 to 46 verifies of waiting changes a day, taking 930 to 1,036 minutes (about 70% of the day; main verifies and idle time are the rest). Only 13 to 17 of those verifies a day passed, and a passing verify is the one that runs its full length: a median of 36 to 39 minutes, with integration at 34 to 37, end-to-end at 27 to 29 and unit at 22 to 24. A failing verify stops early, so a helper saves less on it.

**The arithmetic, laptop on the integration lane.** A passing verify falls from about 38 minutes to about 30 when integration drops below end-to-end. That saves 8 minutes on 13 to 17 verifies a day: 104 to 136 minutes. The design's own checks take about 15% of that back (one verify in ten holds nothing back, and spot re-runs), leaving 88 to 116 minutes. At the Studio's average of 31 minutes per verify of a waiting change that is about 3 to 4 more verifies, and at the measured 0.48 merges per verify, **about 1.5 more merges a day (1.4 to 1.8) if the laptop is free for every verify**. Any saving on failing verifies would add to this and is not measured.

**With end-to-end as well** (not yet measured in the sandbox; the dry run measures it): a passing verify approaches the unit lane's 23 minutes, a saving of 15 minutes, and the same arithmetic gives **about 3 a day (2.6 to 3.4)**.

**What is not measured: how often the laptop is free.** Its owner uses it most of the day. At half availability the figures halve: **under 1 a day from integration alone, about 1.5 with end-to-end.** The line merged 57 changes in the last 24 hours, so this design by itself is a gain of roughly 1% to 6%.

**Said plainly: that is small.** The walls are no longer what limits it. What limits it is that one busy laptop is shortening one lane of the slower machine, and that machine still holds a whole test slot for every change.

**Why build it anyway.** Three reasons, and an approver should weigh them:

1. **It is the foundation of the larger gain.** If a helper can carry most of a verify (every file that passes in its sandbox), the run machine's own part of that verify is small, and the run machine could test a second change at the same time. **My estimate, with one measured input, is 6 to 17 merges a day per helper.** The working: the laptop's integration lane is measured at about 19 minutes in one process; its unit and end-to-end lanes are not measured. If a whole verify takes the laptop 40 to 60 minutes, that is 24 to 36 extra verifies a day when it is always free, or 12 to 17 merges at 0.48 merges per verify, and half that (6 to 8) at half availability. Until the dry run measures the other two lanes this is an estimate, not a finding. It needs everything in this design (the sandbox, the same-tree proof, practice, spot re-runs, take-back) plus one more change: a second verify at once on a run machine. That change is a separate, later design. The scaling session (echo, topic 145097) decides within a week of the laptop's dry-run report whether to open it, on one question: do the measured numbers project that the run machine's own part of a verify becomes small enough to run a second verify beside it? As a guide, that needs the unit and end-to-end lanes proven for the laptop and a whole verify's files taking it about an hour or less; these are guide values, not cut-offs, and the report shows the projection either way. If the answer is no, the session says so in the report and the larger step is ruled out for that helper. Nothing in this design caps a helper's share below what it has shown it can finish, so no wall here stands in the way.
2. **Most of it is built.** Draft PR 3474 holds the sandbox, the governor, the routes, the comparison and the check slice.
3. **Nothing counts before a better number is known.** The dry run and practice measure availability and speed, which gives a projection of the minutes saved; the minutes themselves can only be measured once counting starts, by the comparison group below. If practice projects under 1 merge a day and the dry run rules out the larger step, the throughput session decides whether to decline counting and have the helper role switched off.

**Can the laptop finish its share in time?** Half the Studio's integration lane is about 9.5 minutes of test time on the laptop, one file at a time, plus about 3 minutes to prepare the code (an estimate; the dry run measures it). The Studio spends about 18 minutes on the other half, after about 5 minutes of its own set-up. So yes, with room.

**How it is measured.** One verify in ten is assigned, at random and before the helper is asked, to hold nothing back (F). The main comparison is the run machine's occupied minutes per verify across all verifies in each group, passing or failing, where hand-backs stay in the group they were assigned to. The share of verifies that pass is reported beside it for each group. Comparing by whether the helper happened to finish, or only among passing verifies, would be misleading: both depend on things the helper changes. Minutes saved are reported as measured; the extra merges a day are a projection from them, and that projection is what the 1-merge-a-day line is judged on.

**The M5.** Its lanes are already close together (a 4-shard integration trial began on 2026-11-18 at 20:48 PST). A helper pays less there. The Windows PC pairs with it, and its speed is unknown until its dry run.

## Proposed design

### What stays from the first design, in brief

- **The sandbox (first design, B and B2).** A Linux virtual machine on the helper: Lima on macOS, a dedicated WSL distro on Windows. No host folders are mounted and no ports are forwarded. CPU, memory and disk are fixed. Inside it, a `builder` user installs packages and builds, and a `tester` user runs tests; neither can change the network rules. Tests and the build run with no network at all. Only package installation has network, limited to DNS and public HTTPS. These walls are checked at every start, and a failed check means the helper does not run.
- **The governor (first design, E).** Every 2 seconds the helper measures its owner's use of the machine. It stops work at once when the owner needs the cores, on memory pressure, on battery, at a deadline, on a cancel or on a pause. The sandbox itself is stopped to give memory back. The owner can pause the helper from his phone.
- **Requests and answers (first design, C and E).** Every request is signed by a run machine the helper has pinned, expires in 60 seconds and can be used once. Every answer is signed by the helper and lists each requested file exactly once.
- **Trees.** The helper's host fetches code itself from the pinned repository (fetching runs no code), copies a plain file tree into the sandbox, and locks it read-only. Each slice gets a fresh writable overlay that is thrown away afterwards.

### B2 (amended). The sandbox's network for tests

A test's network namespace had only its own loopback. It now also has **one dummy interface with a private address** (`dummy0`, `10.77.0.2/24`) and no default route. Tests that look for a non-loopback interface find one. Nothing is reachable through it.

The start-up check gains a paired test. From inside a test namespace, a connection to a listener the helper service has just opened on the host, on a local-network address and on a tailnet (private overlay network) address must each fail, while the same listener answers a connection made from the host side. A failed connection alone proves nothing; the pair proves the wall.

### C (amended). What a helper accepts

**The request** now carries `lane`, `baseSha` and `headSha` in place of a single commit. The signature, expiry, single-use and route rules are unchanged.

**The helper checks, itself, before running anything:**

1. **`baseSha` is merged:** reachable from `main` in the pinned repository.
2. **`headSha` is ours:** either equal to `baseSha` (a main verify), or GitHub lists an open pull request whose head commit is `headSha` and whose head repository is the pinned repository itself, compared by repository id. A fork, a closed pull request, a head that has moved, or a missing head repository is refused. That GitHub serves the commit proves nothing; only the listing does. If GitHub cannot be reached or limits the request, the helper refuses.
3. **Its own dry run is done:** a `headSha` different from `baseSha` is refused (`dry-run-not-done`) until the helper's own record shows a completed dry run of the requested lane on its current sandbox image. The record is a file on the helper's host, outside the sandbox, written by the helper service as each lane's dry run finishes: the lane, the image's digest, the sandbox settings' hash, the commit and the date. So integration practice does not wait for the end-to-end dry run. The helper does not take this on the run machine's word.

   **"The image changes"** means, everywhere in this document, that the pinned base image's digest or the sandbox settings change. The daily re-creation of the sandbox from the same pinned image is not a change.
4. **The tree.** The helper builds the merge of `baseSha` and `headSha` in its own clone (`git merge-tree --write-tree`, which runs no code) and prepares that tree. It writes the files out with a method that ignores git's export attributes, so the files in the sandbox are exactly the hashed tree. Its signed answer carries the tree's hash. The run machine uses a result only when that hash equals its own merge tree's.
5. **The install inputs.** These are the files installation is declared to use: `package-lock.json`, `package.json`, the `.npmrc` settings file, and a list kept in code of the files and folders that `package.json`'s install steps run (a unit test fails if an install step names a path the list does not cover). The helper reads the two JSON files from the merge tree, sets the fields that hold the project's own version to empty (every release changes them and nothing else), and hashes all the inputs together. The hash must equal the hash of the same inputs at this verify's `baseSha`: the change must leave the install inputs as `main` has them. Otherwise the helper refuses (`install-inputs-changed`), and the run machine runs that verify's files itself. A change that restores an older package list is refused too, even if the helper once installed that list. The cache of installed packages is then looked up by that hash, and is filled only from a merged commit after the helper's own merged check for it. A file that does not parse, or that has linked or local-path packages not on the merged commit, is refused the same way. So tests on a helper do not run against packages that this change's own installation would have produced differently, as far as the listed inputs show. **Residual:** an install script that reads some other repository file is not covered. That can only make a helper's result differ from ours for such a change; it cannot expose the owner's machine, because installation always runs from merged code.

**Packages are installed only from merged code.** When installed packages for a hash are not already cached, the helper installs them in the tree of the merged commit on which it recorded that hash, with that commit's own install steps and settings. The installed packages are then made root-owned and read-only inside the sandbox, before any file of a waiting change is placed beside them, and they stay so through the build. The build of a waiting change runs as `builder` with no network and cannot write to them, so one change cannot alter the packages another change's tests will load. A waiting change's own install steps never run on a helper, so **a waiting change's code never runs with network access there**. If that makes a file fail on the helper, it is handled like any other helper failure.

The same hash is the key for reusing installed packages between trees. The first design keyed on the raw file, which changes on every release, so its reuse would never have worked.

**The helper's GitHub token** gains read access to pull requests, still read-only and still on the one repository. It stays on the host, outside the sandbox.

### D (amended). Which files may go

- **Any lane** the request names, minus the exclusions below.
- **Never sent:** tests that need the Mac desktop helper, Chrome, the Codex CLI, launchd or tmux. None of these exists in the sandbox image. If one is added to the image later, its tests leave this list through the dry run.
- **The word scan records and does not block.** Hits are still written (`scan-hit`) and listed in the reports.
- **The learned list,** one per helper, kept on the helper. A file joins it when:
  - the helper fails it and the run machine's final result is a pass, on the same tree, in two comparisons in a row; or
  - its digest of test names and outcomes differs from the run machine's on the same tree while both sides pass, once (below); or
  - once, when the run machine's final result is a failure and the helper passed it (a confirmed wrong pass, below).

  A file leaves the list when a later trial agrees. Trials happen when the file's content or the helper's Instar version changes, and otherwise every 10th verify. A trial is always compare-only: the run machine runs the file too, even while the helper is counting.
- **A file this helper has never been compared on** (a new test file, for example) is run by both sides, compare-only, until one comparison agrees. A digest difference on that first comparison puts it on the learned list at once, so it cannot count on the next verify.
- **A lane is "proven" for a helper** when the dry run finished it with files worth at least half of the lane's time passing. Below that the lane would mostly produce learned-list entries, not help. This replaces the first design's "a quarter of files on the learned list is incompatible" for lanes other than unit.

### E (amended). How a helper runs a slice

- **Preparation starts when the verify starts,** not when the lane starts, so the run machine's own set-up minutes are not wasted. A verify that ends before its lanes start cancels the preparation.
- **Order of slices.** A helper runs one slice at a time. The check slice goes first, then slices whose results will be used, then compare-only slices.
- **One process per slice, files one at a time.** This is how the integration and end-to-end lanes run on our own machines. It removes the per-file start-up cost the measurement paid (about 9 minutes over the lane). The helper runs one slice at a time. The first design's clean-up kills every test process after a slice, which would also kill a second slice running beside it; running two at once is left to a later change that gives each slice its own process scope.
- **A slice's time budget** is 60 seconds of helper time for integration and end-to-end, and 10 seconds for unit. On the laptop the average integration file took about 1 second, 6 files took over 30, and the longest took 64. A file longer than the budget goes alone.
- **Progress.** The helper's status answer lists the files finished so far, with the slice's count of unhandled errors so far, a rising sequence number, and the request's ids, signed. Results taken from progress are provisional. They are used only if the slice's last signed answer, final or hand-back, reports no unhandled error and no unexplained exit, and repeats the same result for each file. A last answer that contradicts earlier progress is an invalid answer.

### F (amended). The run machine's side

**Setting,** on a run machine: `monitoring.localVerify.borrowed = { mode: 'off' | 'practice' | 'count', helpers: [{ machineId, url }] }`. Absent or malformed means `off`. The first design's value `shadow` is read as `practice`. Only the throughput session sets it, and each run machine is set separately. The setting is not part of the policy hash that the two run machines must share.

**Pairing.** Each helper serves one run machine. The laptop pairs with the Studio and the Windows PC with the M5. The helper enforces this: it accepts slices from one pinned run machine at a time, and changing that is a change to the helper's own setting.

**Where the exchange runs.** A verify runs in a child process. The plan, the merge of helper results and the take-back live in the child's lane flow, behind one new seam in the orchestrator. The child holds no key: it asks its own server over loopback, and the server signs the request, forwards it, checks the answer's signature and returns it.

- **What the child may ask.** The child proves which verify it is with that verify's existing attempt token. The server takes the commits, the lanes and the helper from its own record of that verify, never from the child's request, so nothing else on the machine, and no test, can use the route to send other work to the owner's machine. The route answers only on loopback and refuses anything that arrived through the tunnel.
- **It can never hold the lane.** Each call has a 5-second limit. A slow, failing or missing server means "no helper answer", and the files are run locally. A test runs a verify of a waiting change with a throwing and with a silent route and checks the record and outcome equal those with the setting `off`.
- **Afterwards.** The child reports each file's helper outcome in its result, and the server alone updates the practice record. If the server restarts, the child ends as it does today, and the helper's deadline ends its slices.
- **Version.** The lane-flow code is part of the verifier's version, so that version changes with this build and with any later change to that code, as for any verifier change. The upgrade note says so.

**On main verifies the first design's rule stands unchanged.** The practice client is a detached observer: never awaited, every error caught, compared only after the record is written. The first design's test stays: a main verify with a throwing or a silent client produces the same record and finish time as with the setting `off`.

**Asking the helper.** At the start of every verify the run machine sends one status request with a 2-second limit. No answer means no helper for that verify. After 10 unanswered requests in a row the run machine asks on every 5th verify only, and a helper that wakes sends its run machine one signed "I am here" request, which restores asking on every verify at once. After 7 days without an answer the run machine stops asking until the helper announces itself. So a long outage costs a request every few hours and then nothing, and a laptop that wakes is used on the next verify. On a main verify the request is made inside the detached observer.

**Which lanes, and how much.** From recorded times, the run machine projects each lane's finish. It gives the helper files from whichever lane is projected to finish last, then recomputes, and repeats until the helper's budget is used. The budget is the helper's measured speed × (the time until the lane's own shards are projected to finish − the helper's preparation time), because that is when unfinished files are taken back. A lane's share starts at a quarter of its time and follows the helper's measured finish rate after 5 verifies. The helper's status answer says how many workers its owner's use leaves free at that moment, and the share is scaled by it. Speed is measured as test time finished per second over the slices the helper actually ran, so a hand-back lowers nothing by itself and the share rises again as soon as the helper is free. The share is never below one slice. Only lanes in the state the mode needs are used (below). Helper times never enter the run machine's own duration records; verifies that run everything locally keep those fresh.

**Verifies that hold nothing back.** Main verifies always run everything locally. In addition, one verify in ten of a waiting change is made compare-only, chosen at random before the helper is asked and written in that verify's record. Those verifies keep the run machine's timings fresh, give same-code comparisons on waiting changes, and are the comparison group for measuring the gain (below).

**Baseline results.** The coordinator keeps, for its last three green main verifies, each file's passed, failed, skipped and to-do counts and the digest of its test names and outcomes, in a bounded file that tests cannot write (`state/local-verify/main-file-counts.json`). It sends a baseline to a peer when it changes (it is under 1 MB for about 5,500 test files), not with every request, and keeps the baseline of a dry run's commit until that dry run ends. The pass definition and the dry run both read it.

**The plan (counting).** The helper share is divided among the lane's shards in advance, in balanced portions, cut so that no local file filter can match a file that was held out. Each shard runs its own files first. When a shard finishes them, it takes back whatever in its portion has no accepted result, cancels those on the helper, and runs them in a second process together with its spot re-runs. If there is nothing to take back and no spot file was drawn, no second process starts. The second process runs under the lane's own deadline, its file list is cut so that no filter matches a file a first process already ran, and its exit code and unhandled errors count toward the lane exactly as the first process's do. A lane with no duration-balanced plan gets no helper share. The unit lane's single process gets an explicit file list.

**So the worst case is bounded.** With a silent helper, every shard runs exactly the files it would have run today, in two processes instead of one. The lane takes today's time plus one process start per shard. One cost is real and is measured, not assumed away: a file that would have failed early is, if it sits in the helper's portion, reached only after the shard's own files, so a failing verify can take longer to fail. A test places an early-failing file in a silent helper's portion and records the time to the failing verdict, and the benefit report counts occupied minutes across failing verifies too. No single process ever carries the whole share, so the lane's 45-minute hang limit is not approached. A lane stop (fail-fast or a deadline) cancels the helper's slices.

**One result per file.**

- A result from the run machine always wins.
- A helper answer for a file that has been taken back is ignored and recorded as late.
- Accepted helper passes enter the lane's report through one function, before the existing decision about re-running a failed file alone. A test checks that only this function feeds helper results in, and only passes.
- The run machine's run of a taken-back or helper-failed file is that file's first local run. The existing rules then apply to it, including one re-run alone if it fails.

**What a pass is.** A helper result is a pass only when the file was collected, ran at least one test, failed none, and a digest of every test's full name paired with its outcome (passed, skipped or to-do, duplicates kept) equals the baseline's digest for that file (above). So the same tests ran, the same tests passed and the same tests were skipped. Equal counts would not show that: a file can skip one test in place of another, or register fewer tests on Linux, with the counts unchanged. A file with no such baseline, or a test file this change adds or edits that reports any skip, is run locally.

**A failure from a helper is not a result.** The run machine runs the file. Slice-level trouble (a crash, an unhandled error, an exit the failed files do not explain) discards the whole slice the same way.

**The check slice.** Every verify adds one slice of fixture test files with known outcomes: passes, assertion failures, a thrown error, an unhandled rejection, skips. They sit at a fixed path, so a helper or a change could recognise them. They are there to catch a runner that is broken by accident, which is the common fault, and the document claims no more for them. The check slice is the first slice a helper runs after preparation. A shard that reaches its take-back before the check slice's answer has arrived takes back its whole portion. If a change edits the fixture files, that verify sends no slices.

**Spot re-runs.** These are the check nobody can predict. After any disagreement from a helper, its rate is 1 in 5 for that helper's next 50 verifies, then returns to 1 in 20. A spot re-run compares the full digest of test names and outcomes, on the same tree, not only pass or fail. When a shard finishes its own files, the run machine draws, with a cryptographic random source, each helper-passed file in that shard's portion with probability 1 in 20, and runs the drawn files itself. They always run, and may extend the lane by their own time.

**A confirmed wrong pass.** If the run machine's final result for a file is a failure, after its own re-run alone, and the helper passed that file on the same tree, then:

- the verify fails on the run machine's result, as it would have without a helper. The helper's other files are not re-run: the verdict is already decided;
- the file joins that helper's learned list;
- the event is written to the audit log with the helper, the file, the tree and both results.

A single local failure that passes on its re-run is recorded as a flaky test and is not a helper fault.

**A same-tree digest difference with both sides passing** (found by a spot re-run or a compare-only verify) means the file registers different tests on the two systems. The file joins the learned list at once. **Residual:** the baseline comes from an earlier `main`, so a change that adds a test which exists only on macOS, through a file the test imports, is not seen by the baseline check; it is caught only by a spot re-run, a compare-only verify or the next main verify. A local failure that gets no re-run (the existing budget is spent) is recorded as unconfirmed and counts for nothing.

**More than five disagreements in one verify** are treated as one event of unknown cause, on our side or the helper's (a broken run on either machine looks like this). That verify uses no helper result: a counting verify is not given a passing verdict until the lane has made one final local pass over every file the helper passed. The helper is **suspended** at once: nothing from it counts on any later verify until its next compare-only verify. If that verify agrees, or shows only digest differences where both sides pass (those files join the learned list), counting resumes with the evidence it had. If it confirms any wrong pass, or shows a mass disagreement again, the helper lapses. `suspended` is a state in the practice record, so it survives a restart. This rule takes precedence over the single-event lapse below, so a broken run on our own machine costs a suspension of a few hours, not the practice period.

**Practice.** In `practice`, and in `count` for a lane not yet counting, the run machine holds nothing back: it runs every file and compares. On verifies of waiting changes the comparison is made in the lane flow once the lane's final results are known; on main verifies by the detached observer. A verify never waits for a helper in practice: when the lane ends, outstanding slices are cancelled. A file agrees when the digest of its test names and outcomes is equal on both sides (the same rule a counted pass uses, extended to failed tests), where the run machine's side is its final result.

**Asking for the failing direction.** After a verify's record is written, the run machine sends the helper, as a detached task, the files whose final local result in that verify was a failure, on the same tree. The verify does not wait for the answer. This is how the evidence below is gathered without waiting for a failing file to fall in the helper's share by chance.

**The evidence that ends practice,** per helper and per lane, on the helper's current sandbox image and the helper's Instar minor version:

1. **Coverage:** every file of the lane that was eligible at the dry run has been compared at least once on the same tree. The dry run's own comparisons count. In practice, files still uncovered are sent first, as compare-only slices, in whichever proven lane they belong to, whatever the lane allocation says, so coverage does not depend on which lane happens to be slowest. This is checked once, at the decision to count. Files added later are compared the first time they are seen (D).
2. **Spread:** comparisons from at least 5 separate verifies, at least 3 of them of waiting changes.
3. **The failing direction:** at least 5 comparisons in which the run machine's final result for a real test file (not a fixture) was a failure and the helper reported at least one of the same tests failing, from at least 3 different files and at least 2 verifies. One comparison is one file in one verify. A file the helper could not collect, or that failed there only on tests that passed locally, is recorded separately as an environment difference and does not count. And the check slice exactly right in each of the last 20 verifies that carried one. This is the direction that matters: agreeing on passes shows little. It replaces the first design's "a minimum of helper-green, local-red comparisons" for a later design.
4. **No confirmed wrong pass** in the helper's last 500 file comparisons on that lane.

A verify in which the helper finished nothing is not counted and resets nothing.

**Residual accepted:** real failing comparisons come from whatever fails that week, so they do not cover every kind of failure. Spot re-runs and main verifies cover the rest for as long as the helper counts.

**The decision to count.** When the evidence is complete the practice report goes to the throughput session: agreement by direction, the learned list, how often the helper was available (counting answers that came after the 2-second limit) and finished its share, the minutes that would have been saved, and the owner's account of any slowdown. The throughput session decides. It may decline. It records the decision, with date and reason, on the ladder entry and in the practice record for that helper and lane (one signed request to the run machine), and sets `count`. A pass counts only where that recorded decision exists for the helper, the lane and the current practice period. The mode `count` alone admits nothing: a second lane whose evidence completes later needs its own decision, and so does a lane coming back from a lapse. The code also checks the evidence: a decision with incomplete evidence behaves as practice. If the evidence is not complete 7 days after practice began, the report is sent anyway on what was collected, and the throughput session chooses one of three recorded outcomes: continue practice for a stated period; start counting under the 7-day exception; or switch the helper off. Practice therefore always ends in a decision.

**One rule decides admission,** and both the route that records the decision and the verify itself use it: all four items as written; or, when the recorded decision says "7-day exception" and at least 7 days have passed since the current practice period began, the same four items with item 3's number lowered from 5 comparisons to 3, from at least 2 files and 2 verifies. Nothing else is relaxed: coverage, spread, the check slice's history and the wrong-pass window all still apply. The items are evaluated when the decision is recorded; afterwards only the lapse events below end counting.

**Counting lapses** for a helper and lane, back to practice, when:

- a compare-only verify (a main verify, or the one in ten) confirms a wrong pass on five files or fewer (more than five is the suspension rule above);
- confirmed wrong passes occur on two different changes within 24 hours;
- three answers in a row are invalid, or 5 of the last 20. An answer is invalid when its ids, signature, file list or tree hash are wrong. A slice discarded for its content (a crash, an unhandled error, an oversize result) is not an invalid answer: test content can cause those;
- the helper's sandbox image or the helper's Instar minor version changes;
- there has been no agreeing comparison for 7 days.

The first three are faults. The last two are ordinary events.

After a lapse, items 2, 3 and 4 are required again, counted from the lapse. Coverage is kept unless the image changed, in which case the dry run is repeated.

**Who is told.** Every confirmed wrong pass and every lapse is written to the audit log and sent to the throughput session, which operates the line. The owner hears, in the topic where he was asked about that machine (topic 145097 for Justin's two machines), only when the repair itself was not enough: a helper's pass let a change merge that then made `main` red, or a helper has lapsed for a fault three times in 7 days. Ordinary lapses never count toward that. Otherwise these events appear in the 7-day report. Notices are sent once, by the coordinator. For the M5's helper, the status the coordinator already polls from the M5 gains an optional list of helper events with ids, so none is missed or sent twice.

**Reports.** The scaling session (echo, topic 145097) writes the dry-run, practice and 7-day reports. Each asks the owner for his own account of any slowdown; no reply is recorded as no reply and holds nothing up.

**The record.** A verify's record gains `borrowed: { helper, lanes: [{ lane, files, filesDigest }] }`: a count and a digest per lane. The record check accepts it only as a known machine id, at most three lanes, a whole number of files up to 20,000 and a 64-character digest. The file list itself goes in the audit row only for a verify with a hand-back, a disagreement or a discarded slice; otherwise the count and digest are enough. The M5's signed record for a peer run carries the field unchanged; the existing signature covers it.

**The practice record** is one file on the pairing run machine, `state/local-verify/borrowed-helpers.json`: per helper and lane, the four evidence items, the state (`practice`, `counting`, `suspended`, `lapsed: <reason>`) and the image and version they belong to. A lost or unreadable file means practice from the start, by intent. Its entry in the state-coherence registry is rewritten to say that it now decides whether a helper's passes count.

### The dry run

One per helper, on a merged commit that a run machine verified green, under the governor, possibly over several idle periods. It runs every eligible file of every lane once and compares with the baseline results for that commit (F). It produces the starting learned list, the helper's speed and preparation time, which lanes are proven, and the helper's own "dry run done" record that C requires before any waiting change. On the laptop the integration lane was measured by hand on 2026-11-18; the dry run repeats it through the real path and adds unit and end-to-end.

### G (amended). Visibility

- `GET /local-verify` shows the mode and, per helper and lane, the state, each evidence item's progress, the last verify's share and how much of it the helper finished.
- The helper's dashboard shows what it is doing, the last refusal and the pause switch.
- The awareness entry `src/data/awareness/local-verify-borrowed-helpers.md` describes both sides, the pause switch and how to read a helper's state.

### The ask to the owner

Sent once per machine by that machine's own agent, before its helper role is turned on. Each carries the line stating when the constitution check was run on this design and what it found. The benefit figure is the one current on the day it is sent.

**For the laptop:**

1. **The problem:** before a change to Instar can be merged, it is tested on our two computers. The slowest parts are two groups of tests on the Studio. Inside the sealed box, running alone, your laptop took 19 minutes of test time for the slowest group. Our machines take 38 and 48 minutes for it while also running the other groups, so the comparison is not like for like, but the laptop is fast enough to be worth trying.
2. **Exactly what changes:** the sealed Linux box already on your laptop (5 GB, switched off) is switched on when a test run wants help. It gets at most half the cores and 8 GB of memory. These tests are heavier than the quick ones tried on your laptop before. It cannot see your files or reach your home network. It uses your internet connection only to download the standard software packages. **This goes further than what I described to you on 18 November,** when the laptop was only to practise, on code already merged, with nothing it said being used: after one pass on merged code, it runs our own code that is still waiting to be merged, in practice as well as afterwards. It stops whenever you are busy, on battery or short of memory. First its answers are only compared with ours. Once they have been shown to match, its passing answers are used. A wrong answer from it could let a faulty change through. Our own machines' next full check, a few hours later, catches it if the fault is still present.
3. **If yes:** a few more merged changes a day: between 1 and 3 by my estimate, depending on how often the laptop is free, and it may turn out less. The practice period measures how often the laptop is free and how fast it is, and I report a projection from that before anything is used; the saving itself is measured in the first week of use. It is also the first step toward a larger gain. You can pause it from your phone, and `instar helper uninstall` removes it completely. One risk stays that we cannot remove: a flaw in the virtual-machine software itself.
4. **If no, or you wait:** nothing is switched on and the line runs as today. There is no deadline.

**For the Windows PC**, the same four parts with these differences, written out in full when it is sent: the box does not exist yet and is installed first (a separate Linux system inside Windows, 30 GB at most); its wall is weaker than the laptop's, because it shares a core with the Linux system the Echo agent already uses there; its speed is unknown, so the benefit is stated as unknown until its dry run, which is reported before practice starts.

The benefit figure in each ask is taken from this document's benefit section, or from that helper's latest report once one exists.

## Build decisions

The builder's first read of the code raised questions the text above leaves open. These answers settle them. None changes what the reviewers approved; each makes a rule above buildable against the code as it is.

- **History on the helper.** The helper's clone today fetches one commit deep, which cannot build a merge. It fetches `baseSha` and `headSha` with full commit history and no file contents until needed (a partial clone). If the merge conflicts, the helper refuses (`merge-conflict`).
- **What the loopback route trusts.** The verify child plans the file lists and knows its merge tree's hash; the server knows the commits, the lanes and the helper. The server takes those three from its own record, accepts file lists from the child only as paths of test files, bounded in number, and never forwards a commit or address the child names. The helper runs only files of the tree it built itself.
- **The attempt token.** It is on the child's command line today, and tests run as the same user as the child. That is the existing trust boundary of Local Verify (a change's tests can already write the run's report files) and it is not widened: through the route a test could at most make the helper run more files of the same tree. The child is given the server's port with the token; the route accepts the token in place of the server's Bearer credential, on loopback only.
- **The baseline file.** It lives in the server's state folder, outside the run tree. "Tests cannot write it" is corrected to: its hash is written to the audit log when the server writes it and checked when it is read; a mismatch means no baseline. A baseline is used for a verify only if its commit is `baseSha` or an ancestor of it, and only for files whose content is the same in the merge tree. With no usable baseline nothing counts on that verify. A main verify that ran on a peer returns its per-file counts and digests with its record, so the coordinator can keep them.
- **Main-verify comparisons on the M5.** The detached observer skips peer runs. That stays. The M5's same-code comparisons come from its one-in-ten verifies.
- **The existing re-run rule.** Where this document says a failed file gets one re-run alone, the code's actual rule applies unchanged: up to 3 failed files re-run alone, from a budget shared across the verify. A local failure that gets no re-run because the budget is spent is "unconfirmed".
- **Slices are queued.** Today the helper answers a slice request only when the slice has finished. It changes to accept, queue and answer at once with an id; results come through the signed status answer. That is what makes slice order, progress and the 5-second route limit possible.
- **The prepared tree outlives the verify briefly.** A cancel no longer deletes the tree. The helper keeps it until the run machine says the verify is over or 10 minutes pass with no request, so the failing-direction request can use it. A helper's answer lists the names of failed tests, at most 50 per file.
- **Progress leaves the sandbox through the root-owned runner,** on a pipe the runner opened, never through a file in the tree.
- **"Version" means the helper's runner version:** a hash of the helper's own runner and sandbox-driver source, computed the way the verifier's version is. Instar's release number moves several times a day and is not used. Evidence resets, and learned-list trials run, when the runner version changes.
- **The package cache survives the daily re-creation.** It is kept on its own volume beside the sandbox image, root-owned, with a manifest of hashes checked before each use. A failed check discards it.
- **Who starts things.** The scaling session starts a dry run through a route on the run machine (`POST /local-verify/borrowed/dry-run`). The throughput session records the decision to count through `POST /local-verify/borrowed/decision`. Both use the run machine's ordinary credential. The decision is written to the practice record, the audit log and the maturation ladder's evidence log (not to the ladder's source entry).
- **Where a helper finds its run machine.** Its pinned requester is `{ machineId, url }`; the "I am here" request goes to that address.
- **The record field** also carries `assigned: 'counting' | 'compare-only'`. The record check validates the helper's machine id by format; whether the machine is known is checked where the record is imported.
- **Smaller points.** One helper per run machine. A unit slice uses as many workers as the governor allows, as in the first design; integration and end-to-end slices use one. An absent `.npmrc` hashes as empty. The digest's outcomes are passed, skipped and to-do. After a mass disagreement the final local pass runs as one more process per shard. Comparisons from a verify whose child crashed are lost and count for nothing.

## Decision points touched

| Decision point | Classification | Basis and evidence |
|---|---|---|
| Whether a helper accepts a request (C) | invariant; basis: irreversible-consequence; evidence: code that has run on a personal machine cannot be un-run. Symbol: GitHub's listing of an open pull request with this head commit and the pinned repository's id; `baseSha` reachable from `main`; the helper's own dry-run record. State: "this is our own code, and this sandbox has been shown to work". Corroboration: the listing comes from GitHub with the helper's own token, not from the requester. Unmeasurable (GitHub unreachable or limited, head moved): refuse. | |
| Whether packages may be installed (C) | invariant; basis: irreversible-consequence; evidence: an install step runs with internet access. Symbol: the hash of the merge tree's install inputs with the version fields emptied. State: "installation of this change would produce what is already installed from `main`". Corroboration: the hash was recorded only after the helper's own merged check, and installation runs in the merged commit's tree, so the claim does not rest on the hash alone. Unmeasurable (file does not parse): refuse. | |
| Whether the sandbox's walls allow the helper to run (B2) | invariant; basis: irreversible-consequence; evidence: a sandbox with a host mount or a route out exposes the owner's files and network. Symbol: each probe's result. State: "nothing inside can reach outside". Corroboration: each failed connection is paired with the same listener answering from its own side. Unmeasurable (a probe cannot run): refuse. | |
| When the helper stops for its owner (E) | judgment-candidate; floor: the sandbox's fixed CPU and memory are a hard ceiling; memory pressure, deadline, cancel and pause always stop; battery stops unless the owner turns that off. Arbiter: the measured owner load. Conservative default: stop. | |
| Which files are never sent: the Mac-only list (D) | invariant; basis: enumerable-domain; evidence: the tests need tools that are absent from the sandbox image (the Mac desktop helper, Chrome, the Codex CLI, launchd, tmux). | |
| Whether the word scan keeps a file off a helper (D) | invariant; basis: enumerable-domain; evidence: never. It is a recorded signal with no authority; the sandbox is the wall. | |
| Whether a file is on the learned list, and whether a lane is proven (D) | judgment-candidate; floor: a confirmed wrong pass or a same-tree digest difference always excludes the file. Arbiter: comparison results. Conservative default: do not send. | |
| Which lanes and how much a run machine sends (F) | judgment-candidate; floor: only eligible files, only lanes in the needed state, never more than its measured speed and reported free workers predict. Arbiter: recorded durations and the helper's measured speed. Conservative default: a quarter of the lane, or nothing. | |
| Whether a helper's pass counts (F) | invariant; basis: enumerable-domain; evidence: a closed list of facts: mode `count`; a recorded decision to count for this helper, lane and practice period; the lane's evidence complete on the current image and version; a valid signed answer; the answer's tree hash equal to the run machine's merge tree; the pass definition met; no slice-level trouble; the check slice right; not a main verify. Symbol: the helper's signed per-file result. State: "this test passes on this merge tree". Corroboration: spot re-runs and main verifies, which the helper cannot predict or influence; the check slice corroborates only that the runner is not broken by accident. Unmeasurable (any fact missing or unreadable): the run machine runs the file. | |
| Whether a helper's failure counts (F) | invariant; basis: enumerable-domain; evidence: never. The run machine's own run decides. | |
| Whether practice has ended (F) | judgment-candidate; floor: the four evidence items, checked by code. Arbiter: the throughput session, on the practice report, which may decline. Symbol: counters in the practice record. State: "this helper reports failures as failures and passes as passes on this lane". Corroboration: the failing-direction comparisons come from real failing tests on the same tree. Unmeasurable (record lost or unreadable, image or version changed): practice from the start. Conservative default: stay in practice. | |
| Whether a pass was wrong (F) | invariant; basis: enumerable-domain; evidence: the run machine's final result, after its re-run alone, is a failure where the helper passed on the same tree hash. A single failure that passes on re-run is a flaky test, recorded as such. Unmeasurable (tree hashes differ): recorded, not counted. | |
| Whether counting lapses (F) | judgment-candidate; floor: on any confirmed wrong pass, that verify uses no result from that helper. Arbiter: the listed events, which separate one change behaving differently on Linux from a helper that is wrong on merged code. Conservative default: lapse. | |

## Fixed limits

Each is a setting behind `off` and `practice`, so changing it later is cheap. The practice report and the 7-day review revisit every one.

| Limit | Value | Reason |
|---|---|---|
| Failing-direction comparisons to end practice | 5, from at least 3 files and 2 verifies | Enough that one file or one bad verify cannot supply the evidence alone. cheap-to-change-after |
| Spread | 5 verifies, 3 of waiting changes | So the evidence is not one moment or only merged code. cheap-to-change-after |
| Wrong-pass window | none confirmed in the last 500 comparisons | About one verify's share; it makes the lapse recoverable. cheap-to-change-after |
| Starting share of a lane | a quarter | Enough to measure the helper's speed without leaving much to take back. Replaced by measurement after 5 verifies |
| Spot re-runs | each helper-passed file with probability 1 in 20 | About 5% of the gain. A file the helper serves on most verifies is re-checked about once a day. cheap-to-change-after |
| Slice budget | 60 s for integration and end-to-end, 10 s for unit | Measured: 6 integration files took over 30 s on the laptop, the longest 64 s |
| Lane proven | files worth at least half the lane's time pass in the dry run | Below that the lane yields learned-list entries, not help. cheap-to-change-after |
| Invalid answers | 3 in a row, or 5 of the last 20 | The second part stops a helper that alternates good and bad answers |
| Evidence age | 7 days without an agreeing comparison | A helper switched off for a week practises again |
| Practice review | 7 days after practice begins | The phase end that does not depend on evidence arriving |
| Compare-only verifies | one in ten, at random | Enough for a weekly comparison group of about 20 verifies on the Studio; costs a tenth of the gain. The 7-day report states the spread of the measured saving, and the rate is raised if that spread is too wide to judge the gain. cheap-to-change-after |
| Mass disagreement | more than five files in one verify | Above what one change behaving differently on Linux has produced so far; treated as a fault of unknown side. cheap-to-change-after |
| Learned list | two in a row to join; trial every 10th verify | The first design's values, kept. cheap-to-change-after |
| Switch-off line | under 1 merge a day with the larger step ruled out | Below this the gain is within the noise of the line's daily count. Decided by the throughput session |
| Status request | 2 s; every 5th verify after 10 unanswered | One short request; a waking helper announces itself, so the slower rate never delays its use |

All other limits are the first design's and keep its reasons.

## Multi-machine posture

- `monitoring.localVerify.helper` (on the helper): machine-local. machine-local-justification: hardware-bound-resource. It describes that machine's cores, memory, disk, sandbox and owner.
- The helper's learned list and its dry-run record (on the helper): unified by placement. One copy per helper, read by its run machine through `GET /local-verify/helper-status`.
- `monitoring.localVerify.borrowed` (on a run machine): machine-local. machine-local-justification: operator-ratified-exception, commit 6a8c3a2c26afeb3df573d5a9ae9e93ce775b3f17 (the approved Local Verify capacity spec: run-machine dispatch is set per machine by the operator).
- The practice record: unified by placement. One file, on the helper's pairing run machine, and every decision that reads or changes it is taken on that machine from its own comparisons. No other machine needs to write it. The coordinator reads it through the peer status it already polls. Re-pairing a helper starts practice again on the new run machine.
- The baseline results (`main-file-counts.json`): unified by placement. The coordinator writes it and sends it to peers; a peer never writes its own. It is listed in the state-coherence registry.
- Notices: one voice. The coordinator sends them, including for the M5's helper.

## Maturation plan

- **ladder:** local-verify-borrowed-unit-slices
- **ladder entry:** added by PR 3471. This build updates its title, plan, preference reason and measures: the ran measure becomes counted helper files, the harm measure becomes confirmed wrong passes.
- **test-agent-live:** a throwaway WSL distro on the Windows PC, created and removed by that machine's agent, **after the owner's yes for that machine**, because the proof runs a waiting change there. It must show: the paired network checks with the dummy interface; the merge tree built on the helper with the same hash as the run machine's; a waiting change refused before the dry-run record exists and accepted after; a fork and a moved head refused; a changed package list refused; installation running in the merged tree only; each shard taking back its portion after a hand-back, a refusal and a silent helper, with the lane time measured; a helper pass with a skip difference run locally; a confirmed wrong pass discarding the helper's results; a single flaky failure not doing so. The macOS proof uses the existing stopped sandbox on the laptop and runs after the owner's yes, as the first step of the dry run.
- **dev-agent-live:** the laptop with the Studio and the Windows PC with the M5, in parallel. Each: the owner's yes, the dry run, practice, the decision to count.
- **graduation criterion:** practice to counting, by the admission rule in F (the four evidence items, or the stated 7-day exception) per helper and lane, checked by code, then the throughput session's recorded decision. Review-due: 7 days after practice begins, on whatever was collected.
- **review after counting starts:** at 7 days, a report to Justin and the throughput session: the median verify time and merges per day with and without the helper; availability; hand-backs; spot re-runs; confirmed wrong passes and lapses; his own account of any slowdown. If the measured gain is under 1 merge a day and the larger step (a second verify at once) has been ruled out or not opened, the throughput session decides whether to switch it off, and Justin is told in the report.
- **fleet:** each helper is enabled only by its owner.
- **dark-window:** from merge until an owner says yes and the throughput session sets `practice`.
- **owner:** echo (scaling session, topic 145097).

## Tests

- **Sandbox property (a condition of the approval):** a test that fails if, from inside the sandbox as `tester` or `builder`, any host path is readable (a marker file in the owner's home, any mount of a host folder) or any host credential is reachable (the helper's GitHub token, the agent's secret store, SSH agent or keychain sockets). It runs against the real sandbox in the throwaway proof and at every sandbox start; the suite runs the same assertions against the driver's configuration.
- **Unit:** an early-failing file in a silent helper's portion (time to the failing verdict recorded); a change that restores an older package list refused; a restart between a suspension and the next compare-only verify; the 7-day exception refused on day 6 and admitted on day 7; a file that skips a different test from the baseline with equal counts is not a pass; a check slice that answers after a shard's take-back; the 7-day exception admitting 3 failing-direction comparisons and nothing else relaxed; the lane allocation and share; the per-shard portions and the file-filter cut; every way a file returns to the run machine; result precedence; the pass definition with skip baselines; the progress rules; each evidence item and the reset keys; the count check with incomplete evidence; the confirmed-wrong-pass rule on both sides of the flaky boundary; each lapse event; commit acceptance (merged, own-branch head, fork, closed, moved head, GitHub unreachable); the merge-tree hash check; the package hash with the two fields emptied; installation in the merged tree; the scan recording without blocking; the record field and its bounds through a peer run; the main-verify observer producing an identical record.
- **Integration:** the helper routes with `lane`, `baseSha` and `headSha`; refusals with reasons; signed progress; the loopback proxy route; `GET /local-verify` fields.
- **E2E lifecycle:** run machine and helper on the production path on one host, through the first design's named test seam: a dry run; practice reaching complete evidence; the count decision; a counted verify with a hand-back and a spot re-run; a confirmed wrong pass. Wiring tests check the signer, the GitHub reader, the sandbox driver, the governor, the loopback proxy and the practice record are real, not no-ops.

## Risks

- **A helper passes a test that really fails.** The change merges. The next main verify runs everything on our own machines, a few hours later, and fails if the fault is still there; the main-red hold then stops merges until `main` is repaired, exactly as for a flaky test that passed once. A fault that a later merge happens to hide would not be caught that way, which is also true today of a flaky test that passed once. Spot re-runs and the one-in-ten verifies make a helper that is wrong repeatedly short-lived.
- **Our own waiting changes on a personal machine.** They run inside the sandbox with no route out, from our own branches, with packages installed from merged code. Named residuals: a flaw in the virtual-machine layer; on Windows, the kernel shared with the Echo distro; a Linux kernel flaw that gives code root inside the guest, which would reach the guest's own network connection (the pinned base image is replaced, by a code change, when a kernel fix calls for it); and a branch of ours that carries code copied from an outside contribution, which this check treats as ours.
- **The gain is small.** With integration alone and a busy laptop it is under 1 merge a day. The benefit section says why it is built anyway and when it is switched off.
- **Owner impact.** Integration slices are heavier than the unit trials measured so far. The governor and pause switch are unchanged, and both reports include the owner's account.
- **Build size.** Draft PR 3474 holds the sandbox, the governor, the routes, the comparison and the check slice. This amendment changes the acceptance checks and the package installation, adds lanes, the merge tree and the dummy interface, moves the client into the lane flow behind a loopback proxy, and removes the scan's blocking and the back-off.

## Frontloaded Decisions

1. Results count after practice ends on the four evidence items and the throughput session's recorded decision. No further design and no second ask to the owner.
2. Waiting changes run on a helper in practice and in counting, after that helper's dry run on merged code. Forks never.
3. Both sides test the merge tree; the request carries `baseSha` and `headSha`; a result is used only on an equal tree hash.
4. Packages are installed only in a merged commit's tree, and only for changes whose install inputs equal a merged commit's.
5. Main verifies never count helper results and keep the first design's detached observer.
6. A helper's failure is never used. A pass needs the same tests with the same outcomes as the baseline (a digest of names and outcomes). A local result always wins.
7. A wrong pass is confirmed only by a repeated local failure on the same tree. Counting lapses on the listed events only.
8. The practice record lives on the pairing run machine; every decision about it is taken there. The laptop pairs with the Studio, the Windows PC with the M5.
9. The exchange runs in the verify's child process through a loopback proxy on its own server; the child holds no key.
10. The word scan records and no longer blocks. This reverses a fold-in of the first design's approval ("scan as a hard floor"). The Chief of Staff is asked to approve the reversal by name. The reason is the owner's review of 2026-11-18 and the article A Safeguard Must Leave a Benefit: the scan's patterns are Mac paths and tools, and inside a Linux sandbox with no host mount they protect nothing the sandbox does not.
11. Notices go to the audit log and the throughput session; the owner's topic hears only when a helper's pass made `main` red or a helper lapsed three times in 7 days.
12. The throughput session sets `practice` and `count` and decides the switch-off at the 7-day review. Each helper machine's own agent turns the helper role on, after its owner's yes.
13. The build ends at: the build with its three test tiers, and both asks sent to Justin with the benefit figure current that day. Nothing in the build waits on him. The throwaway proof on each machine runs after that machine's yes, as its first step.
14. A second verify at once on a run machine, with a helper carrying most of one, is a separate later design. The scaling session opens it within a week of the laptop's dry-run report if that report shows the unit and end-to-end lanes proven and a whole verify's files under 60 minutes on the laptop; otherwise the report rules it out for that helper.

## Open questions

*(none)*
