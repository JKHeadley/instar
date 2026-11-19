# Side-Effects Review — Local Verify: a second try for a failed test that imports changed code

**Version / slug:** `local-verify-import-related-rerun`
**Date:** `2026-11-18`
**Author:** `echo`
**Second-pass reviewer:** `pending (the independent reviewer runs after this build)`

## Summary of the change

Local Verify is the merge-gate test line. When a lane ends with 1 to 3 failed test files and nothing else wrong, each failed file is re-run once, alone, and a file that passes is cleared as flaky. On a pull request a failed file is refused that re-run when it imports a file the pull request changed. A pull request that edits widely imported code therefore gets no re-runs at all, and any flaky test anywhere fails it (PR 3430, feedback fb-1382c0be-778).

This change adds one narrow exception behind a switch that is off by default (`monitoring.localVerify.importRelatedRerun`). With the switch on, a failed file that imports a changed file, and that the pull request did not edit, is re-run alone three times and cleared only if all three pass, when every test that failed in it has already failed and then passed alone, by the same full name, on a green `main` verify this machine ran itself in the last 7 days. Everything else about the re-run rule is unchanged.

Spec: `docs/specs/local-verify-import-related-rerun.md` (approved, built as written; the points where the build had to interpret it are listed under Conclusion).

Files touched: `src/localVerify/laneReport.ts` (the report parser now keeps test names for failed files; the pure eligibility function), `orchestrator.ts` (classing, the one-or-three run loop, the detail-only run), `LocalVerifyService.ts` (the switch, main evidence in the flaky history, the offered list and its bounds, audit fields, run-log retention), `peer.ts` (the wire parser and the check of a returned clear), `record.ts` (record fields and their validation), `policy.ts` (constants), `localVerifyWiring.ts` (the live switch), `src/testing/selfActionRegistry.ts` (bounds 3 and 9), three data files (ladder entry, state registry, awareness entry), one read-only review script, and tests in all three tiers.

**Proportion:** Tier 2. The whole pull request against `main`, after the second commit: 31 files, 3,454 lines added and 137 removed (876 added in `src/`, 281 in the review script, 1,326 in tests, 613 in specs and their companions, the rest artifacts, data and gate records), before the second commit's own trace and decision record, which add two small files. Effort: 6 spec review rounds (the cap) plus a security read whose four findings were folded in; 3 commit attempts over two commits (the first attempt was refused for one word in the spec that the commit gate reads as an untracked promise of later work; the sentence now says "a separate spec", with no change of meaning). The review effort is high for the amount of code because the change loosens a merge gate; that is in line with the risk, not with the size.

## Decision-point inventory

- `importRelatedEligibility()` in `src/localVerify/laneReport.ts` — add — decides whether an import-related failed file may be re-run on main evidence. A fixed rule over facts the run holds; every doubt is a refusal.
- `ineligibleFor()` in `src/localVerify/orchestrator.ts` — modify — still classes each failed file; an import-related file is now either ineligible (as before) or eligible with three passes.
- `decideIsolationRerun()` in `src/localVerify/laneReport.ts` — modify — returns which re-run files need three passes. Its reasons and their order are unchanged.
- `isolationRerun()` in `src/localVerify/orchestrator.ts` — modify — one run or three, the by-name pass check, the detail-only run.
- `importRefusal()` in `src/localVerify/peer.ts` — modify — refuses a peer record whose import-related clear was not offered.
- `parsePeerRunRequest()` in `src/localVerify/peer.ts` — modify — accepts and bounds the two new fields; strict keys inside `isolation` when the switch field is present.
- `validateRecord()` in `src/localVerify/record.ts` — modify — rules for the new optional fields.
- `noteFlaky()` / `completeMain()` in `LocalVerifyService.ts` — modify — main evidence is written only from a green `main` verify this machine ran.
- Merge authority itself (what a `success` record allows) — pass-through — unchanged.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

With the switch off nothing new is rejected. Two things are tightened regardless of the switch, both on a path between two machines on the same build: a peer-run request whose `isolation` block carries the switch field must carry exactly the four known keys, and a returned record's name fields must be well-formed. Machines on different builds do not exchange runs (verifier mismatch), so no working pair is affected.

With the switch on, the rule refuses honest cases, on purpose, and each is stated in the spec:

- A pull request whose imports legitimately change a parametrized test list in the failed file (a new row in an imported table) changes the file's sequence of test names, so that file gets no second try for that pull request (`testSetChanged`).
- After a merged change adds or renames a test in a file, every open pull request loses eligibility for that file until the test next flakes on `main`.
- A test whose name is over 300 characters, a file with more than 20 failed tests, and a failed name that occurs twice in the file are never eligible.
- A flaky test that has not flaked on `main` in the last 7 days is not eligible. On the first day after install nothing is.

The review script reports how often each of these costs a pull request (the clears-over-refusals number and the list of `testSetChanged` and `duplicateTestName` refusals).

---

## 2. Under-block

**What failure modes does this still miss?**

- A regression that fails only under load, in a test `main` has already shown flaky, can pass three solo runs and merge. Solo runs do not test the in-load condition. The protection is the main evidence, not the three passes. Accepted and stated in the spec; the day-7 review's rate on `main` is the check.
- A pull request that makes an already-flaky test flakier can clear. Nothing at verify time tells "flaky as before" from "flakier now".
- Same test, different failure than on `main`: it can clear. The record carries both failure lines, a cut marker, and pointers to both full outputs, and the review lists these for reading by hand.
- Hook errors in a NESTED suite (a `beforeAll` or `afterAll` inside a `describe`) are not visible in vitest's JSON report: the file-level `message` is empty. A failed nested `beforeAll` marks the tests under it as skipped (vitest 2.1.9, `@vitest/runner`), so beside a listed flaky failure the file still looks eligible at classing. The parser's `fileLevelFailure` sees only file-level cases (a file-level message, a failed file with no failed test, a failed count above the named count). The gap is closed at the solo runs: a solo run of an import-related file is a pass only if the file skips exactly as many tests as in the lane run, so a nested `beforeAll` that failed under load and passes alone (its tests now run) ends the sequence as `skipped-count-changed`. `FileCounts.skipped` is available per file in both reports. What remains: a nested hook error that changes no skipped count, that is a failed `afterAll`, or a hook in a suite with no tests of its own counted as skipped, is caught only when it also fails a solo run (a failed file with no failed test counts one failure there).
- The import scan's blind spots (`require()`, `vi.mock` paths, non-relative imports) are unchanged: a file the scan cannot relate to the change is plain, as before. Filed as fb-9b2be76e-79d.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The rule lives where the existing re-run rule lives: the classing and the run loop in the run child (`orchestrator.ts`), the pure decisions in `laneReport.ts`, the state and the switch in the service. The run child still reads neither config nor the history; the service computes the list and hands it over, and a peer never computes a list for a run it was handed. No new store, no new process, no new reporter: the parser reads what vitest's JSON report already carries. The bounded-text helpers are the shared ones in `src/core/boundedInput.ts`, used instead of new slices.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [x] Yes — but the logic is a hard-invariant check of the kind the principle's carve-out names, not a judgment call.
- [ ] ⚠️ Yes, with brittle logic — STOP.

This change sits inside an authority (the merge gate's test verdict) and widens what can pass it, so it is held to the stricter side of the principle. The decision is a deterministic rule over enumerable facts: the file was edited or not, its import graph reaches a changed file or not, each failed test's full name is on the list or not, the name-sequence hash is equal or not. Nothing is weighed, no text is matched for meaning, and no failure line is compared to decide anything (the lines are recorded for a person to read). The verdict has to come out the same on the coordinator and on a peer from the same input and be checkable from the record alone, which is why no model arbitrates it. Every missing or malformed input falls to the conservative side: the file is ineligible, which is the rule as it was. The judgment that remains (is three the right number, is per-test evidence too strict) is assigned to the day-7 review, with a written rule and a named owner.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

**Does this change add a static heuristic at a competing-signals decision point? If yes: why is it not a judgment point within a floor?**

The spec's "Decision points touched" section declares both points. (a) Classing a failed file is an invariant over an enumerable domain: each combination of the facts above maps to exactly one class. (b) What clears an eligible file is declared as a judgment candidate with its floor stated: bounded actions (at most 3 files and 9 solo runs per verify), a conservative default (switch off, a name not on the list, a failed test not reported passed by name, or any solo failure gives the old result or a failure), and a deterministic last rung (the file failed). The arbiter of the tunable parts is the day-7 review, not a run-time model.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** the lane-wide rule is unchanged: one ineligible failed file in a lane still stops every re-run in that lane. The new class is checked after "unavailable" and "edited", so neither can be shadowed by main evidence. `notCleanOnGreenMain` keeps its role for plain files and is not evidence for an import-related file (tested with both switch values).
- **Double-fire:** a clear is an ordinary `flakyRetried` entry, so the existing flaky tracking counts it and raises the existing `local-verify:flaky:<file>` item. No new attention signal and no new audit event for clears, so nothing fires twice. A detail-only run (after a final failure in its lane) is never recorded, so it cannot feed the flaky history or the evidence.
- **Races:** the re-run budget is still read and spent with no `await` in between; an import-related file counts as one file whatever its number of runs. The offered list is computed once, before the peer marker is created and persisted, so the list that is sent is the list the marker remembers.
- **Feedback loops:** the one that matters is closed by construction: evidence comes only from green `main` verifies the coordinator ran itself. Runs of other pull requests, a peer's `main` record, an arbitration answer and a red `main` write none (each tested). A pull request therefore cannot produce the evidence that clears it. What remains is the stated two-step path (merge a change that makes a test flaky on a still-green `main`, then benefit), which costs an attributable flaky commit on `main` and is on the review's hand-read list.
- **PR 3470 (another session)** edits the peer polling and marker persistence code. The marker change here is one optional field beside `dispatched` and one tolerant reader (`offeredFlakyOnMain()`); `isRemoteMarker` and the restore path are not touched, and the `importRefusal` addition is one block before its final `return null`.
- **Verifier version:** the changed files, and `src/core/boundedInput.ts` which they now import, are in the verifier's import graph. Records under the old version are re-verified once at boot, as with every verifier change.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Other agents / the install base:** nothing changes until the switch is turned on. Two things are written regardless: the test-name fields on `flakyRetried` entries, and `mainSeen` in the flaky history, so that evidence exists when the switch is turned on.
- **Audit log (`logs/local-verify.jsonl`):** `main-record` gains `finishedAt`, `lanesCompleted` and `runLog` (or `source: 'peer'`); every `run-detail` line gains `finishedAt`, and `runLog` when the line is written by the machine that ran the verify (a local run, or a peer's own `source: 'peer-run'` line; not the coordinator's line for a `main` record a peer ran, which has no log on this machine); a PR `run-detail` line gains the three refusal lists with their true counts when the rule refused a file, and `importRelatedClear: true` when it carries a clear. All additive; nothing reads these lines by exact shape.
- **Run log:** `isolation-rerun` gains fields for an import-related file only; `isolation-rerun-ineligible` gains its lists only with the switch on; a new `failure-full` event holds each named failure's whole message (bounded at 8,000 characters, the cut disclosed).
- **Persistent state:** `flaky-history.json` gains an optional `mainSeen` list per file (at most 40 names, 7 days). Run logs, kept without bound until now, are removed once they are older than 30 days, when a run starts (at most once an hour). Nothing in the code reads an old run log.
- **Peer wire:** the `isolation` block carries two more fields, bounded to 200 files, 40 names per file, 300 characters per name and 8 MB in UTF-8 bytes for the whole block.
- **External systems:** none. No GitHub, Telegram or Slack surface changes.
- **Operator surface:** no operator-facing action is added. The switch is a config key the agent sets on request; the review is a read-only script the owner session runs.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable. No dashboard file, approval page or form is touched.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN**, with the result travelling. The evidence is in the coordinator's flaky history, which the state-coherence registry already declares machine-local: it describes this machine's own `main` runs, and that is the security property (nothing a peer returns can add evidence). One machine computes the list and sends it, with the switch, inside the peer-run request; a peer never computes a list for a dispatched run. Both switches must be on for a peer run to apply the rule, and the coordinator refuses to import a clear it did not offer.

Loss of state only tightens: a missing, unreadable, thinner or cut history means fewer names on the list, and a test not on the list is ineligible. A machine that becomes coordinator starts with its own evidence. A restored peer marker without a valid list accepts no import-related clear.

- **User-facing notices:** none added, so no one-voice question.
- **Durable state:** `mainSeen` stays on the machine that observed it and rebuilds from that machine's own runs; nothing strands on a topic transfer.
- **URLs:** none generated. `runLog` and `mainRunLog` are file names on the machine that ran that verify, and the spec says so; the review script is run on each machine.
- **Status surfaces:** no new or changed `/status`, `/health`, `/capabilities` or `/channels` answer. `GET /local-verify` and `GET /local-verify/record` return records whole, so a clear's fields appear there without a route change.

---

## 8. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Set `monitoring.localVerify.importRelatedRerun` to `false` on the coordinator. It is read when a run starts, so every run that starts afterwards uses the old rule, including runs already queued. A run already started, or already dispatched to a peer, keeps the value it was built with; setting the peer's own switch to `false` also stops the rule for dispatched runs not yet started there. No restart and no state to undo: `mainSeen` stays and is harmless.

A code revert is an ordinary patch release. The extra record fields and audit fields are optional and ignored by older readers on the same machine; the verifier version changes again, so records are re-verified once. Run logs already removed by the 30-day retention are not restored (they were transient by the registry's own description).

---

## Conclusion

The change is built as the approved spec says, behind a switch that is off by default, with tests in all three tiers. The review produced no design change beyond the spec. Points where the build had to interpret the spec, for the second-pass reviewer:

1. **The failure line of main evidence.** The store needs each test's failure line, but the record's shared fields carry none and the spec says names stay in the run child. A `main` run's result carries `flakyTestLines`: for each `flakyRetried` file, the line of each test the record already names (the same names, nothing more). The record schema is exactly as specified.
2. **A duplicated name across two shards.** A file reported by two shards makes the whole lane report untrusted today, so nothing in that lane re-runs. The test pins that outcome rather than a `duplicateTestName` reason. Inside one report, names are summed per path.
3. **A reason name the spec does not give.** A file with more than 20 failed tests is refused as `tooManyFailedTests`.
4. **Refusals other than the two named lists** (`testSetChanged`, `duplicateTestName`, `fileLevelFailure`, `namedCountMismatch`, `tooManyFailedTests`) ride on the PR `run-detail` line as a third list, `importRelatedRefused` with its count, so the "too strict" denominator covers all import-related refusals.
5. **`importRelatedClear: true`** is added to a PR `run-detail` line that carries a clear, because the ladder's evidence reader matches flat fields only.
6. **`lanesCompleted`** is derived from the record (lanes that reported at least one file; none for an error), so it is the same for a local run and a peer-run record.
7. **Nested-suite hook errors** are not visible in the report; a second commit added the skipped-count rule for the `beforeAll` case after the independent reviewer raised it (see Under-block for what remains).
8. **Stricter than the text:** the wire parser also checks `setHash`, `runLog` and unknown keys inside each list entry.

The three items the spec's "Left behind" names as fixed in its last edit and not re-reviewed are implemented: the rate denominator (`finishedAt` and `lanesCompleted` on `main-record`, the observation rule in the review script), the byte bound (`flakyOnMainList()` measures the serialized block in UTF-8 bytes and drops the oldest evidence), and the refusal-count carrier (the lists and counts on the PR `run-detail` line). S1 and S2 are covered by tests named in Evidence pointers.

Clear to ship dark, pending the independent second pass.

---

## Second-pass review

**Reviewer:** pending
**Independent read of the artifact: pending**

The independent reviewer runs after this build. It is asked to check S1 (the name-sequence hash and the duplicate check), S2 (no evidence from a peer or a red `main`), the three last-edit fixes named above, and the eight interpretation points.

---

## Evidence pointers

- Unit: `tests/unit/localVerify/laneReport.test.ts` (parser names, hash, duplicate flag, file-level failure, `decideIsolationRerun`), `orchestrator.test.ts` (the describe block "a failed file that imports a changed file, on named main evidence": 21 cases including S1, S3, S4, the detail-only pin and collection on `main`), `record.test.ts` (shared and clearance field rules), `peerVerifier.test.ts` (wire parser, `importRefusal`, dispatch and marker, the peer's own switch, no evidence from a peer `main` record or an arbitration answer), `mainHealth.test.ts` (the describe block "main evidence for the import-related re-run": evidence writing, trim, caps, the 200-file and 8 MB bounds, audit fields, run-log retention), `importRelatedReview.test.ts` (the review script's counting rules).
- Integration: `tests/integration/local-verify-routes.test.ts`, `tests/integration/local-verify-peer-routes.test.ts`.
- E2E: `tests/e2e/local-verify-lifecycle.test.ts` (the live key and a list from a real history file reach the run child's input through the production wiring).
- Also amended, as the spec lists: `docs/specs/local-verify-merge-authority.md` (four sentences) and its plain-language companion.
- Build checks the spec asked for, read from the pinned vitest 2.1.9 source (`node_modules/vitest/dist/chunks/index.*.js`, `JsonReporter`): `fullName` is always present (ancestor titles joined with the test name); a still-running test is reported `pending`; a file's tests are listed by walking the task tree, which is definition order whatever the execution order.

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `unbounded-self-action` (this change modifies a self-triggered controller, the isolation re-run; it fixes no agent-authored-artifact defect).
- **`closure`** — `guard`
- **`guardEvidence`** — `{ enforcementType: ratchet, citation: tests/unit/self-action-convergence.test.ts, howCaught: the controller local-verify-flake-rerun is registered with boundK 9 and perTargetBoundK 3, both derived from LOCAL_VERIFY_LIMITS (3 files per verify x 3 runs per import-related file). Control-loop edge: a lane that ends with 1 to 3 failed files re-runs them. Steady-state bound: the cap counts files and is spent once per verify, so at most 3 files are re-run and each at most 3 times. Settling brake: a file's first solo run that does not pass ends its sequence, and after a final failure in a lane a further import-related file gets one detail-only run. The budget lives inside one verify, so the count does not grow with the horizon. }`
