# Window 25 — disposition of every preserved ref

Per the charter (O2 amendment 2): every preserved ref ends this window in exactly one state —
**integrated+live**, **deferred with reason and owner**, or **rejected with reason**. Nothing
silently omitted. No counts, no cherry-picking.

Status as of 2026-08-23T23:15Z. Entries marked PENDING are not yet final; a ref may not carry
PENDING at window close.

| Ref (refs/w24-preserve/…) | SHA | Charter intent | Current state | Evidence / reason |
|---|---|---|---|---|
| lane-a-fix-1 | ba83191dd | RELEASE | merged into candidate; **PENDING** live proof | ancestor of candidate `70e896ab4`, proven by `merge-base --is-ancestor` with a negative control. Live proof owed: settled grades > 0 on the running service with a `wrong` arm exercised. |
| lane-b2 | 06da09aca | RELEASE | merged into candidate; **PENDING** live proof | ancestor, same control. Live proof owed: authorship column on real rows at the live HTTP surface. |
| lane-e-sessions-read | 31c971836 | RELEASE | merged into candidate; **PENDING** live proof | ancestor, same control. Live proof owed: probe active in the running server. |
| lane-f-reap-outcome | fb0531785 | RELEASE | merged into candidate; **PENDING** live proof | ancestor, same control. Live proof owed: a controlled self-exit writes exitCode/midWork/outcome to the live reap log. |
| lane-a-fix-3 | 42288487c | RELEASE (small) | merged into candidate; **PENDING** live proof | ancestor, same control. Live proof owed: attention READ (#4) and passport (#26) per its artifact. |
| lane-c | 6da049107 | ASSESS at integration | **INCLUDED** | merged cleanly, exit 0, no conflicts, 2026-08-23T21:43:37Z. The charter's condition ("include if it composes cleanly") was met and measured. |
| lane-k | 6b7f17a05 | ASSESS at integration | **INCLUDED** | merged cleanly, exit 0, no conflicts, 2026-08-23T21:43:57Z. Same condition, same measurement. |
| lane-a-fix-2 | 462e09701 | VERIFY-ONLY | **VERIFIED STILL-LIVE** (03:20Z) | its W24 change was a live config activation (#22 self-unblock), not code. Owed: confirm still-live after the deployment restart. |
| lane-a-fix-4 | 8e5b0d2c1 | VERIFY-ONLY | **VERIFIED STILL-LIVE** (03:16Z) | its W24 change was a live topic binding (#1, 409→200), not code. Owed: confirm still-live after the deployment restart. |
| lane-b1-repo | 1f1dafee4 | REJECT or DEFER | **REJECTED** | Its consumed-only delivery rule reverses Justin's ruling of 2026-08-23 ~18:45Z that current delivery behaviour stays. Measured NOT an ancestor of the candidate (`merge-base --is-ancestor` exit 1) — excluded in fact, not only in intent. The correct successor is the notified+consumed two-fact design, which is named future design work and not this window's. Owner: Justin, whenever he names it in. |
| lane-g-parity | 8e5b0d2c1 | NO RELEASE | **NOT RELEASED — measurement artifact** | Instrument #15 is correct; the machines genuinely differ. Feeds the plan document, not the build. Nothing to integrate. |
| lane-h-integration | 9bc149c8b | MEANS, not content | **SUPERSEDED** | It was the W24 integration tree. Replaced by this window's fresh candidate, which excludes b1 and adds k. Its value was the hazard map (four bases; three branches on one routes file), which was carried into this window's brief and used. |
| lane-l | fae2c93e1 | NO RELEASE as-is | **DEFERRED — named blocker, queued** | It PROVED the base64 relay bypass; the FIX is a queued follow-up, not this release. Owner: unassigned, on the charter's QUEUED list. |

## Blockers (not preserved refs, but they ship before the release)

| Item | State | Evidence |
|---|---|---|
| B-1 — stop must not delete the state record | **BUILT, not yet merged into the candidate** | branch on origin at `refs/w25-backup/b1-stop-preserves-state` (`4ba27703c`). Three tiers incl. a new lifecycle test. Must-fail control proven: reverting the source makes the unit test fail with `expected false to be true`. Merge is deliberately held until the two integration failures are resolved, so the diagnosis keeps a clean comparison. |
| B-2 — guard population, exact counts | **HALF MEASURED, half by construction** | On-disk measured with a control (36 Claude / 14 Codex; the 19-count backup proves the count discriminates). Loaded population is NOT readable with current instrumentation — 9 sessions all `unmeasured`, honestly. Satisfied at deploy by restarting sessions, after which loaded == on-disk at a known instant. Sequencing approved by Observer 1 with conditions; conditions recorded in the deploy runbook. |

## Not-yet-final (updated 2026-08-24T00:50Z)

**RESOLVED — the two composition failures.** `lane-a-fix-3` took the silent-fallback ratchet 496→497
and `lane-e-sessions-read` took it 497→498; `lane-f-reap-outcome` caused the crash-during-startup
timeout by teaching the ASYNC liveness check to read a dead pane while leaving the SYNC one blind.
Both fixed without shortcuts (fallbacks now report; the sync path reads the same signal), must-fail
controls proven. Candidate + that fix measures 496 and passes the e2e in 282ms.

**RESOLVED (02:00Z) — blocker B-1 composes after lane 6's repair.** Lane 5 split it: the seam tests
and the ratchet failed on B-1's OWN base (always broken, never noticed — its worker ran only targeted
tests); the two integration failures did not reproduce alone. Orchestrator ruling: the seam tests
encoded the delete-on-stop contract B-1 exists to reverse — contract replacement authorised, NOT a
loosening. Lane 6 delivered exactly that (helper asserts file-exists + active:false + stopped_at, each
changed line commented). Composed candidate `80bd957d0` = lane-4 fix `34b4c20fe` (Tier-1 reviewed,
gate passed) + B-1 `4ba27703c` + repair `2c4d6efeb`. Preserved on origin under both namespaces.

**OPEN (02:40Z) — the composed candidate's full suite: 3 failed / 49,848 passed, EXIT=1. None of the
three is the candidate's.** Proven by base comparison, same environment, and by mechanism:
  (a) `benchmark-divergence-alive` — calendar bomb. Baseline `capturedAt` 2026-07-24T01:20Z, ceiling
      30d, `Math.floor`. Suite 1 at 30.88d passed; suite 3 at 31.03d failed. Red on every branch at
      01:20Z, main included. ALREADY FIXED on main as #1972 (5f12a66ae, 02:11Z).
  (b) `standards-coverage-ratchet` ×2 — the measurement oracle `ls-remote`s the canonical GitHub
      remote for main's sha then `merge-base HEAD <sha>`. Both scratch clones have origin → the local
      agent home, so the sha is an unknown object → `not-proven / protectedBase 0`. Passed 5h ago
      because main had not moved; it moved 41 commits during the window. With a real upstream/main
      the clone measures `proven / 89 / 89 / 89`.
  THE PREMISE QUESTION: the candidate is 17 commits behind main, on base `8e5b0d2c1` which is OPEN
  PR #1967, unmerged. Merging main conflicts in one file where main deliberately removed the
  `protectedBase: 89` literal the candidate carries. Three routes put to Observer 1 (rebase / merge
  main in / ship as-is); recommendation: rebase. ATTRIBUTION COMPLETE (03:00Z), five arms: candidate FAIL / base FAIL / main-in-scratch-clone FAIL
  (ratchet) + PASS (benchmark) / main-with-canonical-remote PASS all / GitHub CI on main GREEN.
  Verdict: ratchet = environment (any clone that cannot ls-remote the canonical server), NOT main and
  NOT a lane. Benchmark = real, on every branch, fixed on main #1972. Article count 89→90 via
  05d490cbf on main; the candidate's literal is stale by construction. ZERO candidate commits touch
  the registry; no src/ file is changed by both sides. Rebase is mechanical: expected conflicts = the
  one test literal (main's resolution) + possibly upgrades/next → upgrades/ rename.
  ROUTE DECIDED BY MEASUREMENT (03:30Z): MERGE main in, not rebase. Both staged. Rebase: 18 commits,
  stops at #2 on an unmerged ratification draft chain (912125761 + 3 more) that main ratified
  differently under #1960 — different patch-id, conflicts on its own fixtures. Aborted, nothing left
  behind. Merge: 2 conflicts (the test literal + a dir rename), both main's way. Same two real
  conflicts; rebase walks 7 commits of dead history to reach them.
  BASE LANDED MID-DIAGNOSIS: PR #1967 merged as a10176d72 at 02:49Z, squashed and REWORKED (194 lines
  from 8e5b0d2c1). First merge (vs 7653f2c85) carried the stale draft's standards-coverage.mjs pin and
  failed one ratchet fixture. Re-merged vs 9773b82da: both files byte-identical to main.
  RE-MERGED TIP a11014456: the two previously-failing files 43/43. Mirrored to both namespaces.
  Full authoritative suite RUNNING on a11014456. Nothing deployed. Merged into the candidate it breaks 5 tests across 4 files:
both `telegram-stop-journal-seam` tests (its own surface — emergency stop into `stopAutonomousTopic`),
the silent-fallback ratchet (it adds 2 more), `feedback-drain-performance`, and
`threadline-pairing-routes`. Isolated by running the identical tree with and without it, same
machine, same environment. Its own worker never ran the full suite, so whether B-1 was always broken
or only conflicts with the candidate is the first question lane 5 must answer. Until B-1 is repaired
the release cannot ship, because the charter requires blockers to ship before the release.

**RESOLVED — stale generated artifact.** `builtin-manifest` failed because `src/data/builtin-manifest.json`
is a gitignored, generated file that goes stale when source changes. Regenerated; 10/10 passing. It
passes on the pristine base, so it was never a code defect.

No ref may move from PENDING to integrated+live while B-1 is unresolved.

## How the product reaches main (measured 03:33Z)
Branch `w25/release-candidate` = a11014456 on origin. Ruleset `instar-main-protection`: 15 required checks; code-owner
review VACUOUS (no owned path changed); `require_extra_approval_for_unattributed_changes` FIRES — GitHub reports 21/27
commits unattributed (two .local author emails, the W24 workers' and the orchestrator's own). One human approval,
Justin's, is a Rung-1 step of the deploy. Rewriting 21 commits' authorship to dodge it is a history rewrite of the
window's product and is NOT done. STRUCTURAL: every agent-authored PR will trip this until the agent git identity is
a GitHub-linked email — a self-unblock worth doing once, not per window.

## Suite on a11014456 (03:12Z→): ONE failure, attributed to the ORCHESTRATOR's merge resolution
`package-completeness > upgrade guide directory contains well-formed guides` — main passes, candidate failed on
`upgrades/ci-rerun-on-review.md`, the fragment I moved by hand when git suggested the dir rename. On main that
fragment was CONSUMED by the release assembler and exists at neither path; under upgrades/ the checker demands the
two user-facing sections the internal-only marker only waives under upgrades/next/. Fix = match main (file removed),
commit ee76b8c9d through the gate. Control: restoring the file restores the failure. `w25/release-candidate` now
= ee76b8c9d. Authoritative suite re-run on ee76b8c9d is the gating number.

## Backup-ref generations (so a count is not misread as "current things")
Under both namespaces: `candidate` (70e896ab4, pre-fix) → `candidate-composed` (80bd957d0, +lane-4 fix +B-1) →
`candidate-merged-main` (a11014456, +main) → `candidate-fixed` (ee76b8c9d, current). Earlier generations are kept
deliberately as the audit trail; the preflight's "≥14 backup refs" arm is satisfied partly by them. The CURRENT
release tip is `refs/heads/w25/release-candidate` = ee76b8c9d.

## Evidence suite on a11014456 — FINAL (03:47Z): 1 failed | 49,937 passed | EXIT=1
The single failure is `package-completeness > well-formed guides`, attributed to the orchestrator's merge resolution and
already fixed on ee76b8c9d (control proven). Both live-:4042 e2e tests passed across four in-window server restarts.
This run is EVIDENCE that the composition is otherwise clean, not the gate. The GATE is the suite on ee76b8c9d,
auto-started 03:47:04Z, log /private/tmp/echo-w25-suite5/full-suite.log.

## Auto-merge cannot touch this PR (03:52Z)
GET /green-pr-automerge -> HTTP 503 `not configured` on this agent. The watcher is DARK here; it cannot arm native
auto-merge on any PR. `step2-open-pr.sh` passes no --auto. Justin's approval for the 21 unattributed commits is his
click and stays a named human step (Observer 1 carries it in the 05:55Z report). No hold label needed; none applied.
