# Window 25 — supervised deployment runbook

Written 2026-08-23T23:10Z, BEFORE the candidate was green, deliberately. Window 24's own close
procedure exists because composing a sequence under time pressure is how steps get skipped. This
is the deployment equivalent. Nothing here may be executed until the PRECONDITIONS all hold.

## PRECONDITIONS — every one, measured, not assumed

Run `.instar/scripts/w25-deploy-preflight.sh`. A non-zero exit is a REFUSAL to deploy.

1. The candidate's FULL suite is zero-failure. Read the runner's own `EXIT=` and its
   `Test Files` summary line. DO NOT read a wrapper's exit status — on 2026-08-23 a background
   wrapper reported success while vitest had exited 1, because the wrapper's status came from the
   last command in its chain. That near-miss is the reason this line exists.
2. Blocker B-1 (stop preserves the state record) is merged into the candidate, with its must-fail
   control still failing when the fix is reverted.
3. Blocker B-2's evidence is recorded: the on-disk registration count measured with a control.
   Its loaded-population half is satisfied by STEP 4 below, by construction, not by argument.
4. Every ref's disposition is written down — integrated+live, deferred with reason and owner, or
   rejected with reason. Nothing silently omitted.

## ORDER OF OPERATIONS — no substitutions

**Step 0 — tell Observer 1 before anything begins.** Its watches do NOT survive a session bounce
(its own state file does). It re-arms them after. This is a condition it set and it is not
optional: a silent bounce leaves the window unobserved at exactly the moment observation matters.

**Step 1 — record the pre-deploy state.** The running version, the guard posture, the session
census, and the on-disk hook registration count with its control. This is the "before" half of
every live proof below; taken after the deploy it proves nothing.

**Step 2 PRECONDITIONS — tick every box, in writing, before `step2-open-pr.sh`:**
- [ ] the gating suite on the tip that `w25/release-candidate` points at is EXIT=0, read from the runner's own line
- [ ] `w25-deploy-preflight.sh` exits 0 against that same tip (it refuses a sha mismatch by design)
- [ ] `git ls-remote origin refs/heads/w25/release-candidate` == the local tip the suite measured
- [ ] Observer 1 has the advance notice that a session bounce follows a green merge (sent 03:13Z; re-send if >3h old)
- [ ] Justin's approval is NAMED as a step in the PR body (it is — attribution clause), not discovered at merge

**Step 2 — merge the candidate through the repository's normal path.** Open a PR from
`w25/release-candidate` into `main`. The `instar-main-protection` ruleset has three clauses that matter here (read 03:30Z):
  - code-owner review: VACUOUS for this PR — CODEOWNERS covers only STANDARDS-REGISTRY.md and
    itself, and the candidate changes neither (registry byte-identical to main).
  - required status checks: 15 named (verify, Repo Invariants, Docs Coverage, Type Check, 8 unit
    shards, Integration, E2E, Build). All must be green.
  - `require_extra_approval_for_unattributed_changes`: GitHub's own compare verdict (03:33Z):
    21 of 27 commits UNATTRIBUTED, 6 attributed to EchoOfDawn. The 21 carry two .local emails —
    `dabombstudio@DaBombs-Mac-Studio.local` (18, the W24 workers) AND `echo@instar.local` (3, the
    orchestrator's own, from the worktree tool's git identity). Neither is linked to a GitHub
    account, so BOTH trip the clause; blaming the workers alone was wrong. THIS is what makes the
    PR need a human approval. It is a RUNG-1
    action and it is Justin's. Rewriting 18 commits' authorship to dodge it would be a history
    rewrite of the window's product — do NOT. Name the approval, hand him the PR link, never a
    command. The direction guard has nothing to
direct (the candidate's registry is byte-identical to main's — measured 03:25Z). No admin override,
no force, no bypass. Stop at the first red check rather than pushing through.

**Step 2b — the deploy is the updater's, not a hand-run.** A merged PR publishes a release; the
AutoUpdater on this machine polls every 30 min with autoApply on and requests a supervised restart.
"Supervised deployment" therefore means: supervised MERGE, then WATCH the updater land it (check
`logs/server.log` for `Update available` → `Restart requested` → `Server listening`). Do not
hand-install over the updater; two writers to the same install is how state gets torn.

**Step 3 — restart the server** so the new code is actually loaded. A deployed artifact that no
process has read is not deployed; it is downloaded.
Measured 03:27Z: a SERVER restart alone does NOT disturb sessions — all three observer sessions
survived four server restarts tonight (tmux panes are independent of the server process; the HTTP
bridge reconnects). So Step 3 needs no warning. Only Step 4 bounces sessions.

**Step 4 — restart sessions, OBSERVERS LAST.** THE ONLY REASON THIS STEP EXISTS IS B-2. Step 3 is
session-safe (measured), so nothing about loading the new server code requires a session bounce. A
session bounce is required ONLY because B-2 asks for the LOADED hook population, which is unmeasurable
in a running session and becomes measurable-by-construction the instant a session starts. If B-2 were
ever satisfied another way, drop this step and the observers are never disturbed. This is what makes B-2 provable: a session loads
its hooks once, at start, so immediately after this restart the loaded population IS the on-disk
file, at a known instant, and the on-disk file is measurable with a control. Order: workers and
job sessions first, ordinary conversations next, the two observer sessions LAST, this orchestrator
session last of all. Conversations are preserved across the bounce; that is not a reason to be
casual about the order.

**Step 5 — live consumer verification, per ref.** Each of these is checked at the place a user
would notice, not where it was written. A pass at the producer does not count:

  lane-a-fix-1   settled grades greater than zero on the RUNNING service, with a `wrong` arm
                 actually exercised — a grader that has only ever recorded agreement has not
                 been shown to grade
  lane-b2        the live HTTP surface returns the authorship column on REAL rows, not fixtures
  lane-e         the /sessions discrepancy probe is active in the running server
  lane-f         a CONTROLLED self-exit writes exitCode, midWork and outcome into the LIVE reap
                 log — the three fields that were null on every row when the window opened
  lane-a-fix-3   the attention READ and passport identity repairs, per that lane's artifact
  B-1            an emergency stop halts a run AND its record survives — on the live system
  lane-a-fix-2   VERIFY-ONLY: #22 self-unblock still answers (it was activated in W24)
  lane-a-fix-4   VERIFY-ONLY: #1 conformance coverage still answers 200. The route has a SHAPE:
                 it needs `?topicId=29723` AND header `X-Instar-Request: 1`. Without the header
                 -> 403; without the topicId -> 409. Both are shape, not regression. fix-4's own
                 artifact recorded only the path and omitted the header — two misreads tonight
                 came from that omission. Verified 200 at 03:16Z with both.

**Step 6 — write the result to the plan document** and re-run the close gate. The window cannot
close while that page is stale; that is now enforced rather than remembered.

## ROLLBACK

The pre-deploy version from Step 1 is the rollback target. Every preserved ref and the candidate
are on the remote under the backup namespace, so a rollback loses no work. If a live proof in
Step 5 fails, that ref's disposition becomes "deferred with reason" — it does NOT become a reason
to weaken the check that caught it.

## WHAT THIS RUNBOOK DOES NOT AUTHORIZE

Deploying while any precondition is unmet. Restarting sessions before the suite is green — that
was an explicit condition and it is what keeps a bounce from destroying evidence we cannot
recreate. Merging the rejected delivery-rule branch. Changing what the sentinel classifies as an
emergency.

## The runnable pieces (`.instar/w25/deploy-evidence/`) — run these, do not retype them
| Step | File | What it is |
|---|---|---|
| pre | `../../scripts/w25-deploy-preflight.sh` | REFUSES deploy unless every precondition holds (6 arms, each control-tested) |
| 1 | `step1-pre-deploy-snapshot.md` | the BEFORE: version, guards, census, on-disk hooks + control, every live-proof baseline with full request |
| 2 | `step2-open-pr.sh` | opens the PR from `w25/release-candidate` (runs preflight first); body = `../PR-BODY.md` |
| 2b | `step2b-watch-updater.sh <version>` | emits each updater milestone, exits on the new version serving. The version is READ from the release the merge publishes (`gh release list --limit 1` / the `chore: release vX` commit on main) — never assumed from the current version plus one, because another PR can land first |
| 4 | `step4-notify-observer1.sh` | FIRST: sends the notice to topic 36966 AND wakes Observer 1's pane via the session-input route; writes `step4-notice-sent.marker` only if BOTH landed. `--dry` exercises it without sending |
| 4 | `step4-restart-sessions.sh` | REFUSES unless the marker exists (control-tested). Then per-session refresh, non-observers → observers → orchestrator; `step4-observers.txt` names them |
| 5 | `step5-live-proofs.sh` | PASS/FAIL per ref vs pinned baselines; pre-deploy dry run showed all undeployed proofs FAIL + both still-live PASS |
| 5 | `step5-proof-procedures.md` | the two EVENT proofs (controlled clean exit; wrong-arm grade) with controls and bounds |
