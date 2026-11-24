# Side-Effects Review — borrowed machines run unit-test slices in a sandbox, in shadow (part B)

**Version / slug:** `lv-borrowed-helper`
**Date:** `2026-11-19`
**Author:** `echo (scaling session, topic 145097)`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

This is part B of the approved spec `docs/specs/local-verify-borrowed-unit-slices.md`, approved by the Chief of Staff on 2026-11-18 at 15:08 PST with three fold-ins, all implemented. A borrowed machine (Justin's laptop, or the Windows PC through WSL) can run small slices of unit tests inside a sealed Linux sandbox. Its answers are compared with a `main` verify's own results and never count.

Everything is dark. The helper side runs only with `monitoring.localVerify.helper.enabled`; the run-machine side only with `monitoring.localVerify.borrowed.mode: 'shadow'`. Neither is written as a default.

New code:
- `src/localVerify/helper/` (16 files): the protocol, admission, seen-attempts, learned list, governor, sandbox drivers (Lima, WSL, test-bypass), the host tree export, the service, routes and wiring.
- `src/localVerify/borrowed*.ts` and `mainRunObserver.ts`: run-machine eligibility, planning, comparison, state, client, the canary, and the detached shadow task.
- Sandbox templates in `src/templates/helper/`, never executed on the build host.
- The Windows owner-signal scripts in `scripts/helper/`.
- `instar helper pause|resume|uninstall`.
- A dashboard card shown only while the role is on.
- State-registry entries.
- The awareness entry.

The ladder entry ships in the base PR #3471.

**Status:** opened as a DRAFT. Justin's 2026-11-18 17:44 feedback (too restrictive) leads to a spec amendment before this goes to Local Verify. That amendment widens the target to integration slices, gives the practice phase an end, and drops merged-only after practice. The sandbox, the owner-first governor, the routes and the signing built here are the parts the amendment keeps.

## Decision-point inventory

- **Helper request acceptance:** add. Pinned requesters, signature, expiry, single-use id, signed target helper, tunnel/loopback refusal, merged-commit check, and file eligibility with the scan as a hard floor that fails closed.
- **Sandbox wall checks:** add. They refuse to start on any failed or unrunnable check.
- **Governor stops for the owner:** add. Reserve, memory, battery, pause, idle and deadline, with a restart-loop hold-off and a host-disk margin.
- **Run-machine shadow:** add. A detached comparison only; no path to `evaluateRun`, and a guard test proves it.

## 1. Over-block

- The fail-closed scan keeps some harmless files local. A hit is recorded with its matched line, so false blocks are visible.
- Merged-only and unit-only limit what is measured. Both are set to relax in the spec amendment, per Justin's feedback.

## 2. Under-block

These are named residuals, from the spec:
- merged code executing inside the sandbox;
- `npm ci`'s filtered internet access;
- on Windows, the WSL2 kernel shared with Echo's distro (a container-level boundary);
- a flaw in the virtualization layer itself.

The Lima image and node digests are not pinned yet. Creation refuses until the throwaway rung pins them, so this fails safe.

## 3. Level-of-abstraction fit

Isolation sits at the virtual-machine layer, the standard for untrusted CI work, instead of per-file rules. Signing and key lookup reuse PR 3451's primitives. The run-machine side is a detached observer of `main` verifies, so it never sits in the verify's path.

## 4. Signal vs authority compliance

- [x] No — this change has no brittle block/allow surface over a verdict.

Shadow results never decide anything. The helper's refusals protect the owner's machine; they are exact checks that fail closed, which is the floor the spec classifies as invariant.

## 4b. Judgment-point check

The governor is a judgment within floors (reserve, memory, battery, pause), with the arbiter as measured owner load, as declared in the spec. Practice-phase defaults are named in code comments, and the 20-run report re-measures them.

## 5. Interactions

- **`LocalVerifyService.ts`:** only a type-only observer hook, called try/catch and never awaited. None of the functions PR 3455 edits are touched. It is a verifier root, so the verifier version changes once.
- **PR 3471:** this PR stacks on it (unit durations, ladder entry).
- **PR 3470:** no shared code.
- **Server boot:** the helper runtime is built only when its setting is on.

## 6. External surfaces

- **New routes:**
  - `POST /local-verify/helper-slice`, `/helper-slice/cancel`, `/helper-learned` and `/helper-pause`;
  - `GET /local-verify/helper-status`;
  - all 404 while disabled.
- **Other additions:**
  - a `borrowed` field on `GET /local-verify`;
  - new audit rows (`borrowed-shadow`, `borrowed-shadow-error`, `scan-hit`, `result-oversize`, `restart-episode`-style counters);
  - a CLI command;
  - a dashboard card.
- **Owner-machine actions:** none, until the owner enables the role after a four-part ask.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

The surface is a card on the dashboard's Development page (`dashboard/console/development.js`, `helperCard`). It shows only on a machine whose helper role is on.

1. **Leads with the primary action?** Yes. The card is short: a plain title, the current state, then the one action, a "Pause practice runs" / "Resume practice runs" button. The button is visible and tappable on arrival, never folded away, and is followed by a live status line ("Paused. Current work stopped.").
2. **Zero raw internals as primary content?** Yes. Refusal codes are translated to plain words by `helperReasonWords` ("your machine was on battery", "there was not enough free disk space"); an unknown code gets "a safety rule did not allow it", never the raw code. A failed sandbox check reads "A safety check on the sealed-off sandbox did not pass, so nothing runs until it does." No ids, hashes or slugs are shown. This was fixed during this review: the first build showed raw reason codes.
3. **Destructive actions de-emphasized?** Pausing is the safe direction. It stops work on the owner's own machine and destroys nothing. Uninstall is deliberately not on the dashboard; it is CLI-only and needs `--yes`.
4. **Plain language + phone width?** The labels are everyday words ("This machine lends spare time to the test line (practice only)"; "Nothing it reports counts toward any change…"). The card uses the page's existing `need-card` layout, which stacks at phone width with full-size tap targets. `console-development` and `console-needs-first-screen` pass; the card has no test of its own.

## 7. Multi-machine posture

As declared in the spec:
- **Helper setting:** machine-local, hardware-bound.
- **Learned list:** unified by placement on the helper, read through `helper-status`.
- **Run-machine state:** machine-local by the ratified Local Verify exception.

No user-facing notices, no topic-bound state, no URLs.

## 8. Rollback cost

- **Fastest:** turn the settings off. The helper routes 404 at once and no slices are sent.
- **Code revert:** removes everything. Any sandbox already created on a helper is removed with `instar helper uninstall --yes` through its driver.
- **No migration.**

## Conclusion

The spec is fully implemented, dark, and opened as a draft, pending the relaxing amendment Justin asked for. The second pass raised seven concerns; all were fixed, with tests, and re-reviewed (below).

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (read-only; findings and re-check at `.instar/state/scaling/borrowed-helper-second-pass.md` in the agent home)
**Independent read of the artifact: concur** (after one round of fixes)

**First read raised seven concerns.** None let test code reach the owner while the walls hold; they were fail-open floors, broken owner-first stops and checks that passed when they could not run:
- the hold-off never released;
- a queued preparation bypassed pause and booted before an owner check;
- the scan failed open;
- the nft hash ignored rules with anonymous counters;
- the Windows disk margin measured the wrong disk;
- the vsock check passed without python3;
- the forward probes had no positive control, and the WSL image had no digest check.

All were fixed with tests and re-reviewed, along with four lesser notes: the first Mac sample, a no-report slice now counts as a slice error, signed target helper, and a streaming size cap.

**Remaining minor notes, accepted:**
- a preparation's owner check records a stop but leaves an already-running sandbox up until the slice path or the idle stop catches it;
- the forward-probe control shows the listener started, not that it was still up at the host's connect, within a 20 s window;
- the WSL digest is hashed and imported through two paths on the owner's own drive.

## Evidence pointers

- Unit tests (niced, at most 5 files per run): 251/251 across the 14 affected files after the fixes, plus earlier runs of `LocalVerifyService` (163), the registry, awareness, console and lint tests.
- `feature-ladders-coverage` + `MaturationLadder`: 54/54 on this branch.
- Typecheck and `npm run lint` clean.
- The integration and e2e files are typechecked; Local Verify is their first run.

## Class-Closure Declaration (display-only mirror)

- **defectClass:** `unbounded-self-action`. New self-triggered controllers: the governor's stops and the sandbox restart, the detached shadow task, and the breaker's probes.
- **closure:** `guard`.
- **guardEvidence:** ratchet `tests/unit/self-action-convergence.test.ts`.
- **howCaught.** Each controller converges:
  - **Sandbox stops.** They act once per stop condition. Restarts are braked by the memory-pressure hold-off (5 min doubling to 1 h, released only after normal samples).
  - **Shadow task.** One per `main` verify, abandoned at unit-lane end.
  - **Unreachable-helper probes.** Backoff from 30 min doubling to 8 h, reset on success.
  - **Clean-up.** Kill up to 3 times, then a sandbox restart.

  None loops without a brake.

## Addendum (2026-11-18 23:40 PST): rework to the approved amendment, stage 1 of 6

The feature is being reworked to `docs/specs/local-verify-borrowed-slices-count.md` (converged in 6 rounds, approved by the Chief of Staff on 2026-11-18 22:27 PT), which amends the first design. This stage adds the shared pure pieces only, and the feature stays dark (the borrowed setting is absent everywhere):

- protocol v2 for helper requests and answers (lane, base and head commits, merge-tree hash, per-file digest of test names and outcomes, failed test names, signed progress);
- an opt-in outcome digest in `parseVitestJson` (`laneReport.ts`). Existing callers get identical output, but the file is part of the verifier's version, so that version changes with this stage;
- the install-inputs hash and its guard test against the real `package.json`;
- eligibility by lane, with the word scan recording and no longer excluding;
- the setting values `off`, `practice` and `count` (`shadow` is read as `practice`; `count` behaves as `practice` until stage 5).

Provisional until later stages: the helper still refuses lanes other than unit and any waiting change, answers carry no merge-tree hash, and comparison is still by counts. Unit tests: 494 tests in 15 files passed across four runs; `tsc` clean. The integration and e2e files edited here were not run locally. The independent second pass for the whole rework is made after the last stage, before the pull request leaves draft.

## Addendum (2026-11-19): rework to the approved amendment, stage 2 of 6 (what a helper accepts)

This stage builds section C of `docs/specs/local-verify-borrowed-slices-count.md` on the helper side. The feature stays dark: the helper role is off unless its own setting is present, and no run machine sends a waiting change yet.

What a helper now checks for itself, in order, each with a named refusal:

- the base commit is merged (`base-not-merged`, `merged-unknown`, `merged-rate-limited`);
- the head commit is the base itself, or the current head of an open pull request from the pinned repository, by repository id (`head-fork`, `head-pr-closed`, `head-moved`, `head-repo-missing`, `head-not-ours`, `head-unknown`, `head-rate-limited`);
- its own dry-run record for the lane on the current sandbox image, before any head that differs from the base (`dry-run-not-done`, `image-identity-unknown`);
- the merge of the two commits, built in its own clone with the run machine's command (`merge-conflict`, `tree-has-node-modules`); the tree's hash rides every signed answer;
- the install inputs of the merge tree against the same inputs at the base commit (`install-inputs-changed`);
- a check slice holds fixture files only (`check-not-fixture`).

Side effects to know about:

- **The helper's clone changes shape.** It was one commit deep; it is now a partial clone with full commit history and file contents fetched only when needed. A clone left by the first design is deleted and made again on first use.
- **Packages.** `npm ci` runs only in the tree of a merged commit, after the helper's own merged check for it. The result lives on its own disk beside the sandbox image (a Lima additional disk; on Windows a virtual disk file made at setup), root-owned and read-only, and is bound read-only into a tree for the build and for every slice. A manifest of file hashes is recomputed before each use; a difference discards the set and installs again from merged code. The disk is not deleted by the daily re-creation of the sandbox, only by `instar helper uninstall`.
- **Setting.** `pinnedRequesters` (a list) is replaced by `pinnedRequester: { machineId, url }`. A helper block that still carries the list is read as disabled. The role was never enabled anywhere, so no migration is needed.
- **Token.** The helper's GitHub token needs read access to pull requests as well as contents, on the one repository.
- **New state files on a helper**, both registered: `state/local-verify/helper-dry-run.json` and `state/local-verify/helper-packages.json`.
- `src/templates/helper/instar-helper-runner.sh` and `provision-sandbox.sh` changed, so their entries in `scripts/blocking-decision-surfaces-baseline.json` were re-declared: the runner still refuses only its own malformed arguments or a broken wall, and every admission decision is authored in TypeScript.

Provisional until later stages: lanes other than unit are still refused (`lane-not-supported`); slices are still answered when they finish, with no queue; a whole-run cancel still deletes the prepared tree; the learned-list request still names a head commit. The package disk and the image identity are proven only by command-line construction in unit tests; the real sandboxes are proven on the throwaway rung, after the owner's yes for each machine.

Unit tests: 573 tests in 19 files passed across four runs (at most 5 files each); `tsc` and `npm run lint` clean. The integration and e2e files edited here were not run locally.

## Addendum (2026-11-19): rework to the approved amendment, stage 3 of 6 (how a helper runs a slice)

This stage builds sections B2, D and E of `docs/specs/local-verify-borrowed-slices-count.md` on the helper side, and the sandbox property test that the design's approval made a condition. The feature stays dark: the helper role is off unless its own setting is present, and the run-machine side (stages 4 and 5) is not started.

What changed on a helper:

- **Lanes.** A helper accepts `integration` and `e2e` as well as `unit`. A slice is one vitest process with that lane's own configuration, as on a run machine; integration and end-to-end files run one at a time, a unit slice uses as many workers as the governor allows. A slice states its budget, at most 60 s for integration and end-to-end and 10 s for unit (`budget-over-limit`). The run environment inside the sandbox no longer sets `CI`, and sets a UTF-8 locale, as the run machines do.
- **Slices are queued.** A slice request is checked, queued and answered at once with its id (`queued`); at most 200 wait (`queue-full`). They are served one at a time: the check slice first, then slices whose results will be used, then compare-only slices. Results come through the signed status answer (`GET /local-verify/helper-status?run=<id>&since=<seq>`): each finished slice's own signed answer, and for the running slice signed progress (the files finished so far, the unhandled errors so far, a rising sequence number, the request's ids). The status answer is also signed as a whole.
- **Progress leaves the sandbox through the root-owned runner**, on a pipe it opened: a root-owned reporter outside every tree writes one line per finished file to the slice's standard error. Never a file in the tree. A hand-back repeats the results of the files that finished; a last answer that would contradict earlier progress is withheld (`progress-contradicted`).
- **Cancels and trees.** A per-slice cancel stops or dequeues only the named slices. A whole-run cancel no longer deletes the prepared tree: it is kept until the run machine says the verify is over (`verifyOver`) or 10 minutes pass with no request for it. A preparation may be asked with no files, when a verify starts, and a cancel stops it.
- **The learned list** follows the amended rules: a file joins when the helper fails it and the run machine passes it in two comparisons in a row, once on a same-tree digest difference with both sides passing, and once on a confirmed wrong pass; it leaves when a later trial agrees. Trials are due when the file's content or the helper's **runner version** changes (a hash of the helper's runner and sandbox-driver source, `helperRunnerVersion.ts`; Instar's release number is not used), and otherwise every 10th verify. The learned request is keyed by the merge tree's hash. The list file is version 2; a version 1 file is not read (the role was never enabled anywhere).
- **Compared on.** A new state file on a helper, `state/local-verify/helper-compared.json` (registered): per lane, the files that have had an agreeing comparison on the current sandbox image and runner version. The status answer reports a count and a digest per lane, and one lane's list on request.
- **Lane proven.** Each lane's dry-run record also stores the helper time of the files that passed and of all files answered, and the share between them.
- **Start-up checks.** Every test namespace gets its own loopback and one dummy interface, `dummy0` with `10.77.0.2/24`, and no default route. The checks gain: the interface and the absent default route; the paired network test (a listener the helper just opened on its local-network address and one on its tailnet address must each be unreachable from a test namespace while answering from the host side; a host with no tailnet address cannot run the check, so the helper does not run); and the sandbox property test (a probe run as `tester` and as `builder`: no host path readable, no host credential reachable, each facet beside a positive control). The first design's fixed-address tailnet probe is replaced by the listener test.
- **Control channel.** Every host command a sandbox driver starts (`limactl`, `wsl.exe`) now gets an allow-listed environment, never the server's whole environment; on Windows `WSLENV` is set empty. Only the digest of the helper's GitHub token is ever passed into the sandbox, for the property test.
- **Package volume.** A missing package volume has its own reason, `package-volume-missing`. The host-disk margin now also counts the package disk's remaining growth (12 GB at most).
- **"I am here".** A helper sends one signed request to its pinned run machine's `POST /local-verify/helper-here` when its service starts, when its owner resumes it and when the machine wakes. The receiving route is built in stage 4; until then the request is answered 404 and audited as not accepted.
- `src/templates/helper/instar-helper-runner.sh` and `instar-helper-checks.sh` changed and `instar-helper-progress-reporter.mjs` is new, so their entries in `scripts/blocking-decision-surfaces-baseline.json` were re-declared or added: none makes a blocking decision; every refusal is authored in TypeScript.
- A fault found by the new start-up check test and fixed: a probe listener's accepted connection had no error handler, so a reset from the prober would have been an uncaught error in the helper's server.

Provisional until later stages: the run machine's main-verify observer still sends one slice at a time and now reads each answer from the status answer; it reports comparisons by counts, mapped onto the amended kinds, with the tree hash the helper named; its last cancel does not yet say the verify is over. The dummy interface, the tailnet listener test, the progress pipe and the property probe are proven by unit tests on the scripts' text, on command-line construction and (for the probe and the reporter) by running the same files against made-up views and against real vitest by hand; the real sandboxes are proven on the throwaway rung, after the owner's yes for each machine.

Unit tests: 679 tests in 25 files passed across five runs (at most 5 files each); `tsc` and `npm run lint` clean. The integration file edited here (`tests/integration/local-verify-helper-routes.test.ts`) was not run locally, and the e2e lifecycle file was not run either.

## Addendum (2026-11-19): rework to the approved amendment, stage 4 of 6 (the run machine, server side)

This stage builds the server side of section F of `docs/specs/local-verify-borrowed-slices-count.md` and the related "Build decisions" on a run machine. The feature stays dark: with `monitoring.localVerify.borrowed` absent every new path is inert, each new route answers 404, no new file is written, and a `main` verify's run input, record and audit rows are what they were (the guard test's identical-record check still passes, and a second test now checks the same with a seam that throws from every method).

**`count` still behaves as `practice` at the end of this stage.** The verify's lane flow that asks the helper through the proxy and uses its passes is stage 5. Nothing calls the proxy yet and nothing feeds the practice record's evidence yet, so no lane can reach `counting` on a real machine. `GET /local-verify` says so (`countBehavesAsPractice`).

What is new on a run machine:

- **The practice record**, `state/local-verify/borrowed-helpers.json`, now version 2 and re-registered: it decides whether a helper's passes count. Per helper and lane: the four evidence items, the state (`practice`, `counting`, `suspended`, `lapsed: <reason>`), the sandbox image and runner version, the practice period's start and the recorded decision. A lost or unreadable file, a version 1 file, or a lane that does not read strictly means practice from the start. The first design's back-off for a silent helper (30 minutes to 8 hours) is gone, with its `helper-unreachable` and `helper-reachable` audit rows.
- **Asking the helper.** One status request with a 2-second limit at the start of every verify, read only when its whole-status signature holds and it is fresh. After 10 unanswered in a row only every 5th verify asks; after 7 days without an answer none does, until the helper's signed "I am here" arrives. On a `main` verify this happens inside the detached observer, which now asks first, before it reads the head's file list.
- **Routes** (all behind the ordinary Bearer credential unless said otherwise, all served by any run machine whose service is built, lease holder or not, because a helper's practice record lives on its pairing run machine, which may be the peer):
  - `POST /local-verify/borrowed/decision` records the decision to count for a helper and lane. It is refused (409, naming the missing items) when the admission rule does not hold. A recorded decision is written to the practice record, the audit log (`borrowed-decision`) and the maturation ladder's evidence log (`logs/feature-evidence.jsonl`, feature `local-verify-borrowed-unit-slices`).
  - `POST /local-verify/borrowed/dry-run` records a request to dry-run a helper (or to stop). Only the request is recorded; the dry-run task that consumes it is stage 6.
  - `POST /local-verify/helper-here` takes the helper's signed "I am here", checked against the paired helper's pinned machine key.
  - `GET /local-verify/borrowed` shows the same summary as the `borrowed` field of `GET /local-verify`, on a machine that does not hold the lease.
  - `POST /local-verify/peer-baseline` (peer side) stores the coordinator's baseline results.
  - `POST /local-verify/borrowed-proxy` is the verify child's way to its helper. **It is the one new exemption from the Bearer gate** (`src/server/middleware.ts`, exact method and path): a loopback socket, no `cf-connecting-ip` and no `x-forwarded-for` header, and the attempt token of a verify that is running now (header `X-Instar-Attempt-Token`). The commits, the helper, the run id and the slice ids come from the server's own record of that verify; a body that names any of them is refused whole. File lists are accepted only as at most 400 distinct test-file paths of the stated lane. Each call has a 5-second limit and any failure reads as "no helper answer". A `main` verify's token never opens it. Because the caller holds no Bearer credential, the general body parser reads at most 64 KB of such a request.
- **Baseline results**, `state/local-verify/main-file-counts.json` (new, registered): for the coordinator's last three green `main` verifies, each file's four counts and its names-and-outcomes digest. Its hash is written to the audit log on every write (`main-file-counts-written`) and checked on every read; a mismatch means no baseline. A `main` verify computes the per-file counts only when a helper is configured on this machine or a peer reported one, so with no helper anywhere the run input and result are unchanged. A peer returns them inside its signed answer, and the coordinator sends the file to a peer that wants it when it changes.
- **The peer exchange** gained four optional things, all strictly parsed and all absent with no helper: `fileCounts: true` on a `main` peer-run request; `fileCounts` in a peer's `run` detail; `helperEvents`, `wantsBaseline` and `helpers` in the peer status; and the route above. A peer keeps the per-file counts only for its newest finished attempt.
- **The record field** `borrowed: { helper, assigned, lanes: [{ lane, files, filesDigest }] }` is validated by the record check (never on a `main` record) and passes through a peer's signed record unchanged. A peer record that carries it is imported only when the helper is one that peer reported as its own (`borrowed-helper-unknown` otherwise); this machine's own record only when the helper is configured here. No code writes the field yet.
- **Notices.** A confirmed wrong pass and a lapse are written to the audit log (`borrowed-helper-event`, `borrowed-notice`) and raised once, by the coordinator, through the existing attention seam as `local-verify:borrowed-helper-event:<id>`. The owner's item, `local-verify:borrowed-helper-owner:<id>`, is raised only for a helper's pass that made `main` red or a third fault lapse within 7 days. A peer never raises one: it lists its events in its peer status and the coordinator remembers the ids it has told.

Side effects to know about:

- **The verifier version changes with this stage.** `record.ts`, `peer.ts`, `orchestrator.ts` and `LocalVerifyService.ts` changed, and `mainFileCounts.ts` joined the verifier's import graph through `peer.ts`. Both run machines must be on the same build before the coordinator hands the peer a verify, as for any verifier change. No borrowed or helper module is in that graph (the guard test still checks).
- **One attention channel for two audiences.** The line's session and the owner are both reached through the attention seam, told apart by key and priority. Nothing else on a run machine can address a single session today, so until one can, a wrong pass or a lapse is also visible wherever attention items are shown.
- **A rejected own record.** A record of this machine's own run that names a helper not configured here is rejected (`record-rejected`, `borrowed-helper-unknown`). No code writes the field yet; stage 5 must make sure a setting switched off in the middle of a verify cannot lose that verify's record.
- A peer's helper events and the baseline wish live in the coordinator's memory and are learned again from the next status poll after a restart; the told ids are kept in the practice record file.

Provisional until later stages: nothing feeds the evidence (the lane flow of stage 5 and the dry run of stage 6 call `recordVerify` and `recordDryRunResult`); the `main` verify observer still compares by counts, sends one slice at a time and does not write to the practice record; the "pass made main red" event has its rule and its notice but nothing emits it; the baseline's use in the pass definition, and its ancestry and same-content selection against a real clone, are stage 5 (the selection functions are here and unit-tested); the dashboard, the awareness entry, the ladder's measures and this upgrade note's main text are stage 6.

Unit tests: 55 files in 11 runs of at most 5 files each, all passed (the largest: 461 tests in 5 files; the 15 files changed after their first run were run again and passed); `tsc` and `npm run lint` clean. New unit files: `borrowedPractice`, `borrowedNotices`, `borrowedRunMachine`, `borrowedServiceSeam`, `borrowedWiring`, `mainFileCounts` and `middleware-borrowed-proxy`; `borrowedState.test.ts` was rewritten for the practice record and the asking rate. The new integration file (`tests/integration/local-verify-borrowed-routes.test.ts`) and the edited e2e lifecycle file were not run locally.

## Addendum (2026-11-19 01:50 PST): self-triggered actions in stages 1 to 4, and why each settles

These stages add or change actions the code takes by itself. Each has a brake:

- **Asking a helper:** one status request per verify with a 2-second limit; after 10 unanswered in a row, every 5th verify; after 7 days without an answer, none until the helper announces itself.
- **"I am here":** one signed request per wake of the helper (a wake is a gap of more than 3 minutes between 60-second sweeps); a refused or failed send is audited and not retried.
- **Notices:** one per helper event id, through the create-once attention seam; ordinary lapses are never sent to the owner.
- **Baseline push to a peer:** a new version at once; a version a peer refused is offered again at most every 5 minutes and, since the second pass of stage 6, at most 5 times.
- **The slice queue and preparation:** bounded queue; refusals found during preparation are remembered per commit pair, so a repeated request is refused at once without preparing again; the loopback proxy has a 5-second limit and never retries.
- **Sandbox stops and restarts, clean-up kills:** unchanged from the first build (memory-pressure hold-off doubling to 1 hour; at most 3 kills, then a restart).

The models for these in `src/testing/selfActionRegistry.ts` are added with stage 6, when the dry-run task and the lane flow, the last two self-triggered paths, exist; until then the feature is dark and none of them runs.

## Addendum (2026-11-20): rework to the approved amendment, stage 5 of 6 (the verify's lane flow)

This stage builds the verify child's side of section F of `docs/specs/local-verify-borrowed-slices-count.md`. The feature stays dark: with `monitoring.localVerify.borrowed` absent the run input carries no `borrowed` block, the verify never asks its server anything, and every lane runs exactly as before (tests run a verify with a silent and with a throwing proxy and check the record and the commands equal a verify without a helper).

What is new:

- **The lane flow, `src/localVerify/borrowedLaneFlow.ts`, in the verify child.** It is part of the verifier's code and its version, as the spec says, so the verifier version changes with this stage. It imports only pure modules (`borrowedEligibility`, `borrowedCanary`, `borrowedPlan`, `mainFileCounts`, `shardPlan`, `laneReport`). The guard test now checks the verifier's import graph holds exactly these lane-flow modules and nothing of the helper, the proxy, the practice record or the observer. A second guard checks that a helper result enters a lane report only through `admitHelperPasses`, and only passes accepted at take-back.
- **Opening it.** A pull-request verify whose input carries `borrowed`, whose change does not edit the check slice's fixtures and whose changed-file list is readable asks its server for a plan (`op: 'plan'`). No answer, no assignment or no status answer from the helper means no helper, and the lanes run as without one. The baseline is chosen against the verifier's own clone: the newest kept baseline whose commit is `baseSha` or an ancestor of it (`git merge-base --is-ancestor`), and only rows of files whose blob is the same at that commit and in the merge commit (`git ls-tree -r` on both). Any git failure means no rows, and then nothing counts.
- **Which files, and how much.** Files the helper may take are whole overlap groups (so no local file filter can match a held-out file), eligible by D, not on the helper's learned list, not fixtures. A counting lane takes only files with a baseline row that the helper has been compared on. Each lane's share is a quarter of its time until the helper has been sent work in 5 verifies, then half its measured finish rate (5 % to 50 %), and zero when the helper's status says no workers are free. Groups go, one at a time, to the lane projected to finish last, while the helper can finish them before that lane's own processes are projected to end (after its preparation). Compare lanes come after counting lanes; uncovered files go first in them.
- **Counting lanes.** A lane counts only when the verify was assigned `counting`, the setting is `count`, the practice record admits that helper and lane, the lane has a duration-balanced plan (or is the unit lane), and it has no first part. The helper's files are held out of the lane's own processes: the unit lane excludes them by name, a sharded lane's shard plan is made without them. Each shard runs its own files, then takes back every group in its portion without an accepted pass (and its spot re-runs) and runs them in a second process under the lane's own deadline. Nothing taken back: no second process. With a silent helper every file runs here, in two processes instead of one.
- **What a pass is** (`isCountablePass`): a valid answer on this verify's own merge tree, no slice-level trouble (an unhandled error, an unexplained exit, nothing collected), the file collected with at least one test and none failed, and its digest of test names and outcomes equal to the baseline row. A test file the change edits that reports a skip never counts. The check slice must have come back exactly right before a shard's take-back, or the shard takes back its whole portion. More than five disagreements so far in the verify takes back everything; more than five found later makes the lane run one final local process over the files the helper passed, and no helper result is used.
- **Comparisons.** At each lane's end the helper's results are compared by digest with the run machine's final results: agreed, a digest difference with both passing, the helper failing where this machine passed, a confirmed wrong pass (this machine's result failed again alone), the failing direction (both failed at least one same test), or an environment difference. A local failure with no solo run is unconfirmed and counts for nothing; one that passed alone is flaky. Outstanding slices are cancelled when the lane ends; practice never waits for a helper.
- **The result.** The child returns `borrowed` in its run result (sent, finished, counted, taken back, spot, late, discarded slices, the comparisons, the check slice, each answer's validity, and the locally failed files). The record gets `borrowed: { helper, assigned, lanes: [{ lane, files, filesDigest }] }` when any file was sent.
- **The server side (`BorrowedRunMachine`).** Preparation is asked when the verify starts, on the first lane a dry run proved. The proxy's `plan` adds the learned list, throughput, preparation time, free workers and per-lane proof, share and uncovered files. Its `status` no longer passes the helper's raw answer: it checks each finished slice's own signature, ids, lane, commits and file list, and passes on only those, marked valid or not, with no signatures. A child may no longer send `verifyOver`; the server tells the helper the verify is over. After the record is written the service hands the flow's result to `onVerifyResult`, which runs the failing-direction request (the locally failed files sent compare-only on the same tree, waited for at most 10 minutes, nothing waits for it), then makes ONE practice-record update for the verify, keeps the counted passes, sends the learned-list observations and writes one `borrowed-verify` audit row (file lists only for a verify with a hand-back, a disagreement or a discarded slice).
- **A pass that made main red.** A red `main` verify hands its failed files to `onMainRed`; any counted pass for a change merged into that head (by this machine's clone) on one of those files raises a `main-red-after-pass` event, which the owner hears. Each counted entry is reported once and then dropped.
- **The main-verify observer** sends all its slices at once (queued) and reads results from the status answer, compares by digest against the main verify's per-file counts and its unit report, feeds the practice record through the same `recordVerify`, and sends the learned list keyed by the main record's own merge tree. Its last cancel says the verify is over.
- **The setting switched off in the middle of a verify** no longer loses that verify's record: the service keeps the helper named when the run started, and a record naming that helper is accepted. A record naming any other helper is still rejected.
- `GET /local-verify` no longer shows `countBehavesAsPractice`.

Side effects to know about:

- **The verifier version changes**: `orchestrator.ts`, `orchestratorSeams.ts` and the four lane-flow modules are in its import graph. Both run machines must be on the same build before the coordinator hands the peer a verify, as for any verifier change.
- **A verify with a counting helper can take longer to fail**: a file that would have failed early is reached only after a shard's own files when it sits in the helper's portion. The benefit report counts occupied minutes across failing verifies too.
- **Practice record v2 gained two optional fields** (a lane's dry run `proven`, a helper's `counted` passes). Older files read as before; nothing was ever enabled.
- **The proxy answers changed shape** (above). Nothing outside this rework read them.

Unit tests: every file under `tests/unit/localVerify` passed (69 files, in runs of at most 5), plus `green-pr-passing-record` and `planned-restart-verify-guard`; the integration files `local-verify-borrowed-routes`, `-helper-routes`, `-routes`, `-peer-routes`, `-peer-works-through-restart`, `-queue-controls`, `-likely-failing-first-routes` and `planned-restart-local-verify` passed; the e2e `local-verify-borrowed-helper-lifecycle` passed; `tsc` clean. New test files: `borrowedLaneFlow.test.ts` (28 tests: the pure rules and take-back), `borrowedServiceVerify.test.ts` (the run input, the result hand-off, the setting switched off mid-verify), six lane-flow cases in `orchestrator.test.ts` against the real `runVerify`, and stage 5 cases in `borrowedRunMachine.test.ts` (the result, the failing direction, a pass that made main red, the child input).

## Addendum (2026-11-20): rework to the approved amendment, stage 6 of 6 (dry run, visibility, ladder, upgrade note)

This stage finishes the rework. The feature stays dark.

- **The dry run, `src/localVerify/borrowedDryRun.ts`.** It consumes the request `POST /local-verify/borrowed/dry-run` records: the run machine's tick starts a requested dry run and stops a stopped one. On the newest commit this machine verified green (the first baseline in `main-file-counts.json`, pinned until the dry run ends and released after), it prepares that commit's tree on the helper, sends every eligible file of each requested lane once as compare-only slices marked `dryRun` (base and head are that commit), at most 20 slices waiting at once, and sends again a file the helper did not finish, at most 5 times. Each answer is compared with the baseline row: an equal digest of test names and outcomes is "compared"; a helper failure on a file that passed on `main`, or both passing with different digests, goes to the helper's learned list; a file with no baseline row (it failed on `main`) is answered but not compared. Per lane it records, through `recordDryRunResult`, the files eligible then, those compared and whether the lane is proven (files worth half of the lane's time passed, weighted by this machine's recorded times), and one measured run (the helper's speed and preparation time, which the share and the plan read). The helper writes its own "dry run done" record from the same slices (C item 3), so the dry run is what lets a helper accept waiting changes. Audit rows: `borrowed-dry-run-start`, `-lane`, `-waiting`, `-end`; an evidence row per finished, stopped or unfinished dry run. The request's state now moves `requested` → `running` → `done`; a server restart mid-run starts it over once; no baseline, no answer or no free pin leaves it `requested` and it is tried again after 10 minutes. It gives up after 24 hours.
- **A lane's proof** (`coverage.proven`, optional, in the practice record) is read by the plan and by the server's preparation at verify start: a lane no dry run proved gets no helper share.
- **Visibility.** `GET /local-verify` shows each lane's `proven` flag and whether a dry run is running (`dryRunRunning`). The console's Development page gains a quiet card on a run machine with a helper ("Borrowed machines practise for the test line" / "help the test line"), one line per helper with each lane in plain words and the last verify's share; it asks nothing. The helper's own card no longer says "practice only" or "only merged code": it now says its answers count only after they have matched, and names the refusals added in stages 2 and 3 in plain words. Pure wording lives in `development-model.js` (`borrowedSummary`, `borrowedLaneWords`) with tests on both sides of each state.
- **The awareness entry** `src/data/awareness/local-verify-borrowed-helpers.md` describes both sides as amended: the helper role and its owner controls, the run machine's `practice` and `count`, the dry-run and decision routes, how to read a helper's lanes, and the audit rows.
- **The ladder entry** `local-verify-borrowed-unit-slices` gets the amended title, preference reason, plan and measures, as the spec's maturation plan says: ran is now `borrowed-counted` rows (one per lane whose passes counted in a verify: the ladder reads row counts, so a row per lane stands for "counted helper files"), harm is `borrowed-helper-event` rows of kind `wrong-pass` (threshold 0). The run machine writes the new `borrowed-counted` row.
- **The upgrade note's main text** (`upgrades/next/lv-borrowed-helper.md`) is rewritten for the amended design.
- **Self-action models** in `src/testing/selfActionRegistry.ts`: `local-verify-borrowed-helper-asking` (a helper that never answers, a verify every 30 minutes for 14 days: at most 80 asks), `local-verify-borrowed-dry-run-resend` (a helper that hands back every slice: each file at most 5 sends) and `local-verify-borrowed-helper-notice` (a peer listing the same events forever: each told once). The three source files carry their `@self-action-controller` markers; `lint-emit-without-admit` is clean and the convergence ratchet passes (883 tests).

Kept from the first design and named so nobody mistakes it for the dry run: the main-verify observer's own `dryRun: true` option still sends every eligible unit file on green `main` verifies. The route-driven dry run above is the one the spec describes and the one that writes coverage and proof.

## 6b. Operator-surface quality (stage 6 addition)

- **Audience and first screen:** the run machine's card sits after anything that needs the operator, so it never pushes a need off the first screen; it has no button and asks nothing. The helper's card keeps its one action (pause or resume).
- **Plain words:** lane states read "its passing results count", "practising (4 of 5 checks met)", "paused after many disagreements in one run", "back to practice after a problem", "not tried yet (no dry run)"; no state code or file path is shown. Helper refusals map to sentences; an unknown code gets a general phrase, never the raw code.
- **Failure states:** with `/local-verify` unreadable, or no helper configured, the card is simply absent (it carries no state the page needs).

Unit tests: every file under `tests/unit/localVerify` (71 files, runs of at most 5), `MaturationLadder`, `MaturationLadderService`, `feature-ladders-coverage`, `feature-maturation-plan-gate`, the awareness registry tests, `claude-md-core-headroom`, `console-development` and `console-needs-first-screen` (182), `self-action-convergence` (883), `degradation-never-silent`; integration `local-verify-borrowed-routes`, `-helper-routes`, `-routes` and `console-static-serving`; e2e `local-verify-borrowed-helper-lifecycle` and `local-verify-lifecycle`; `tsc` clean. New: `borrowedDryRun.test.ts` (against a real helper service: a full dry run, a helper failure, no baseline, a stop).

## Second-pass review (the whole rework, after stage 6)

**Reviewer:** independent reviewer subagent (general-purpose, read-only; it read the spec, `docs/signal-vs-authority.md` and the whole diff against `main`, not the author's conclusions)
**Verdict: concur** (after one round of fixes, re-checked by the same reviewer)

**First read: concern raised, one blocking finding and six should-fix:**
1. (blocking) The "more than five disagreements in one verify" rule was checked per lane at each lane's end, so a counting lane that ended early kept its helper passes when a later lane took the verify past five. **Fixed:** a counting lane that admits passes registers a final local pass; once every lane has ended, if the verify is past five, each such lane removes those passes from its report and runs the files here before any verdict (`orchestrator.ts`, `lateFinalPasses`; test "the mass rule is the whole verify's" through the real `runVerify`).
2. The server applied the same rule per lane. **Fixed:** `recordVerify` passes the verify's total to every lane (`verifyDisagreements`).
3. "A pass that made main red" fired only for this machine's own main verifies. **Fixed:** checked in `completeMain` for local and peer main records alike, leaving out files that passed alone; the coordinator sends a red `main` to each peer that runs helpers (`POST /local-verify/peer-main-red`, lease holder only, strict body), with one retry a minute later.
4. A peer's record could be refused when its setting went off mid-verify. **Fixed:** the coordinator accepts a helper the peer reported in the last 24 hours.
5. The dry run's lane proof counted only answered files. **Fixed:** every eligible file is in the denominator.
6. The dry run and the baseline push retried forever, and the models overstated the brakes. **Fixed:** a dry-run request starts at most 3 times, then stops (`borrowed-dry-run-gave-up`); a refused baseline version is offered at most 5 times; the registry models match the code, and a baseline-push model was added.
7. The share was not scaled by the helper's free workers. **Fixed:** the helper's status names its worker ceiling (`owner.workersMax`), and the share scales by free over ceiling.

Nits, all fixed: one lane's slice cap no longer stops later lanes; the poll's read position moves only past known results; no polling without a share; the dry run reads tree readiness only from a signed status; spot re-runs are drawn per file.

**Accepted residuals (named by the reviewer):** the server may suspend a helper on a verify whose passes the child already used (the failing-direction request adds wrong passes after the verdict; suspension then applies from the next verify); a red-main notice to a peer that fails twice is lost (audited); the coordinator's 24-hour memory of a peer's helpers does not survive a coordinator restart.

**Verified by the reviewer as holding:** a helper failure, a late, invalid or other-tree answer, slice trouble or a timeout only ever leads to a local run; a local result always wins; a file reported twice makes the report untrusted; take-back processes run only their shard's portion; the proxy refuses the tunnel, other forwarders, non-loopback sockets, main-verify and finished tokens, and any field beyond the operation's own; every slice and status answer's signature is checked before the child sees it; with `borrowed` absent no flow runs and the record is unchanged (the one dark change: unit-lane file times now go into the durations file, which only balances shards).

Tests after the fixes: every file under `tests/unit/localVerify` and the neighbour units (all batches green), integration (5 files, 48 tests), e2e (2 files, 21 tests), `self-action-convergence`, `tsc` clean.

## Second-pass review of the November 24 merge refresh

An independent read-only reviewer checked the exact merge `ac0feb5fb` against both parents, covering all six conflict resolutions. Verdict: **concur**.

- The server constructor preserves current main's owner-route and shadow-fold wiring and gains the borrowed-helper dependency. Helper construction, routes, and shutdown remain connected.
- The verifier preserves main's failure capture and wall-time observations for first parts and reruns alongside borrowed-helper flow.
- The feature registry holds 256 unique IDs. The borrowed entry is the only changed entry relative to main. The script baseline keeps main's secret script entry and all four helper entries, with all five hashes verified against the merged files.
- The self-action registry keeps the exact union of both parents, with 152 unique controllers.
- The unit-duration side-effects note matches main, and its removed release fragment had already shipped in 1.3.1944.
- The merged diff passes git's whitespace check. The review used read-only comparisons to preserve the production test slot.

The author ran TypeScript, 1,862 focused unit tests, 16 integration tests, and two end-to-end lifecycle tests on the refreshed tree. This addendum and the trace record the review of that merge.

## Second-pass review of the later November 24 merge

**Reviewer:** Independent Codex reviewer, read-only subagent

The reviewer checked the staged merge of `a715425d9` and `646c926a6`, committed as `f17754e50`. Verdict: **concur**. The only conflict was the server constructor. Removing the single borrowed-helper argument from the resolved constructor yields current main's constructor byte for byte, including the owned-repository dependency. The reviewer verified that each dependency reaches its route mount. The merged diff passed git's whitespace check, and the author reran TypeScript and the commit lint checks.
