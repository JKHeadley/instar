<!-- bump: patch -->

## What Changed

Extends the `deferral-detector` hook (the signal-only PreToolUse guard that scans outbound messages) with a fifth category: **merge-deferral**. It now flags an agent handing the merge of a PR *it authored* back to the operator — both the explicit form ("the merge call is yours", "your call to merge", "leave the merge to you", "merge is your call to make") and the permission-seeking form ("want me to merge?", "should I merge?", "ready to merge?"). Two design points: (1) these patterns are **deliberately NOT exempted by the infrastructure-backed anti-trigger** — having tracked the PR as a commitment does not legitimize handing its merge back; it just launders the deferral; (2) the injected checklist tells the agent to **merge a self-authored green PR itself** (`scripts/safe-merge.mjs … --squash --admin` in the instar repo, or `gh pr merge`), states the operator directed this must never be a blocker, and names the only legitimate non-merges (CI genuinely red on this change, or someone else's PR). Source-of-truth is `getDeferralDetectorHook()` in PostUpdateMigrator.ts (the existing always-overwrite migration redeploys it to every agent on update). Still SIGNAL ONLY — never blocks. Complements instar-dev Phase 7 (Auto-merge on green) at a different layer: Phase 7 governs the build flow; this catches a handed-back merge in *any* outbound message.

## What to Tell Your User

If I ever finish a PR I authored, watch it go green, and then ask you "want me to merge?" or call it "your decision" — there's now a structural guard that catches that framing before the message sends and reminds me that merging my own green PR is mine to do, never a blocker I hand to you. This came directly from your correction that the merge call should never be yours for PRs I authored, and that the fix had to be permanent and in code, not another promise.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Deferral-detector flags handing a self-authored PR's merge back to the operator | automatic (signal-only hook); fires on outbound messages, not exempted by "tracked" work |

## Evidence

Reproduction (live, 2026-06-09, topic 2169): the agent built PR #1040 (the session auto-heal ladder), watched CI, and presented it as "CI is running now … it's core monitoring code, so the merge call is yours." The operator corrected: "the merge call should never be mine, at least not for PRs you authored. Please change this permanently moving forward so it is never a blocker." The existing deferral-detector did not catch it — it had no merge-deferral patterns.

After the fix: `tests/unit/deferral-detector-orphan-todo.test.ts` gains a `merge-deferral` describe block (11 cases) including the exact incident phrasing, the permission-seeking variants ("want me to merge?", "should I merge?", "ready to merge"), the key "tracked PR still fires" laundering case, and the must-NOT-fire cases ("I merged it myself", "I'll merge on green", "merging now"). The deployed hook was verified end-to-end to emit `MERGE-DEFERRAL DETECTED` while staying signal-only. 35/35 deferral-detector tests pass; tsc clean; generated-hook node syntax check passed.
