## Window 25 — CONVERSION: seven proven W24 repairs, composed and measured together

Every branch here was green alone in Window 24 and had never been in the same tree as any other. This PR is the first integrated candidate, and composition found real defects that isolation could not: two tests broke only when the branches met, and blocker B-1 broke tests on its own surface that its worker never ran. All fixed at the cause, none by loosening a test or raising a ceiling.

### What is in it (13 preserved refs, every one dispositioned — nothing silently omitted)
**Integrated:** lane-a-fix-1 (decision-grading ingress, #19), lane-b2 (authorship join at the re-read boundary — Justin's named ask), lane-e (sessions-read discrepancy probe), lane-f (reap-row exitCode/midWork/outcome), lane-a-fix-3 (attention READ limit + passport identity), lane-c, lane-k.
**Blocker B-1** (an emergency stop must not delete the run's state record — it destroyed two 200KB+ records in one day): built, three tiers, must-fail control proven, plus a repair for the seam tests that encoded the old delete-on-stop contract (contract replacement, each changed line commented, not a loosening).
**Rejected with reason:** lane-b1-repo — its consumed-only delivery rule reverses Justin's 2026-08-23 ruling; proven not an ancestor of this tree.
**Verify-only (already live from W24, re-verified 2026-08-24):** lane-a-fix-2 (#22), lane-a-fix-4 (#1).
**Not released:** lane-g (measurement artifact), lane-h (superseded integration tree), lane-l (proved the base64 relay bypass; the fix is a queued follow-up).
Full record: `.instar/w25/REF-DISPOSITIONS.md`.

### Evidence
- Full suite on the composed tip, run in an environment that can reach the canonical remote: see the PR checks; the local authoritative run is logged with the tip sha stamped in the log.
- The two composition failures: bisected to lane-a-fix-3 + lane-e (silent-fallback ratchet 496→498, fixed by reporting before falling back) and lane-f (sync `isSessionAlive()` blind to a retained dead pane the async path already saw). Must-fail controls: reverting restores both failures. Tier-1 side-effects review: `upgrades/side-effects/w25-composition-failures.md`.
- B-1: `refs/backup/2026-08-23-w24/b1-stop-preserves-state`; reverting `AutonomousSessions.ts` fails `stopAutonomousTopic preserves the topic record` with `expected false to be true`.
- Merge of main (not rebase — the rebase replayed an unmerged ratification draft main had superseded): two conflicts, both main's way, plus one resolution the orchestrator got wrong and corrected: a release-note fragment git suggested moving into `upgrades/` had in fact been consumed by main's assembler and belonged at neither path (caught by package-completeness on the composed tip; fixed by matching main; control proven).

### Live proofs owed AFTER merge (runbook Step 5, baselines pinned pre-deploy)
attention `?limit=2` returns 146 rows today → must return ≤2 · passport fingerprint `unresolved` → must equal `63b1dbb2…` · 5 real history rows carry no `authorship` → must carry it · last 3 self-exit reap rows all-null → a controlled clean exit must write all three fields · 39 decision points, 0 settled grades in 7d → a `wrong` arm exercised must settle ≥1.

### Note on the approval this PR will ask for
21 of 27 commits are unattributed on GitHub (two `.local` author emails: the W24 workers' and the orchestrator's own). The `require_extra_approval_for_unattributed_changes` clause fires. That is a real approval to give, not a formality to dodge — rewriting the window's history to avoid it is not done here. The structural fix (a GitHub-linked agent git identity) is a one-time self-unblock outside this window.

Deployed-effective at merge time: still ZERO. It becomes non-zero only when Step 5's proofs pass on the running system.
