# NCB slice 3b — status

**Slice:** native-conversation-base §3b, "The outcome route gives the owner's verdict (F2)".
**Branch:** `echo/ncb-3b-owner-read` (fresh off `origin/main` 3ae8208a6; the spec, its ELI16 and its convergence report are copied in from `echo/native-conversation-base-spec`, PR #3086).
**PR:** https://github.com/JKHeadley/instar/pull/3092 (JKHeadley is a requested reviewer)
**Local Verify:** requested on the Studio (`POST /local-verify {"pr":3092}`) at 15:33 PST 2026-11-11; it answered `queue-full` (10 queued). A retry runs from the M5 Pro session every 2 minutes until the Studio accepts it (up to 2 hours). This note is pushed before acceptance so the head Local Verify runs on is final.
**Merged:** no (by instruction).

## What is built

- `receipt` mesh verb: optional `reader: true`; answers by `role` (execution-owner: full classified verdict + `originMachineId`; author: `holding` / `supersededBy`, plus `delivered` + ids when it sent the reply itself; anyone else: refused). Ladder-facing raw `state` unchanged.
- Classifier reads the closed suppression-reason and failure-cause sets; a `suppressed` row with no reason is `unknown` (no longer "safe to resend").
- `resolveOutcome` (table rows 1–11) and `readOperationOutcome` (local shortcuts, lease-holder ask for an id with no local row, parallel owner + author asks, supersession following, 4 s route deadline). `OriginOwnerReader`: per-ask budget `min(2 s, time left)`, one in-flight ask per (machine, id, envelope), 2 s timeout memo per machine, LRU of terminal owner verdicts (1024).
- `messageOrigin.ownerRead.enabled` (default on, read live, never written; `forwardToHolder.enabled: false` has the same effect), `budgetMs`, `cacheEntries`.
- `GET /telegram/origins/status` → `ownerRead` counters (asks, timeouts, refused, oldVersion, cache, askP95Ms, routeP95Ms, routeMaxMs, routeOverBudget) for the maturation row's kill criteria.
- Reply script honours `safeToResend` (prior shipped hash registered for migration). CLAUDE.md paragraph "Outcome from the sending machine:" for new and existing agents.

## Tests (run on the M5 Pro, TMPDIR outside /tmp, vitest --maxWorkers=2)

- Neighbour unit lane (git-diff selection + migrate*/PostUpdateMigrator): 309 files, 2524 passed, 1 skipped, 0 failed
- Neighbour integration lane: 24 files, 145 passed, 5 skipped, 0 failed (after updating one pre-existing route-test fixture to recompute the envelope digest it rewrites)
- Neighbour e2e lane: 28 files, 145 passed, 0 failed
- Final re-run on the committed code: unit `tests/unit/telegram-origin/` + reply-script + migration tests 57 files / 622 passed; integration outcome-owner, mesh, routes, forward-on-standby 4 files / 52 passed; e2e owner-read-alive passed.

## Second-pass review

Independent subagent. First read raised a real defect (row 6 could say "safe to resend" for a reply the author delivered itself after the owner's own attempt failed) and four smaller points; all fixed, see `upgrades/side-effects/ncb-3b-owner-read.md`. Re-check by the same reviewer: "Concur with the review"; its two defensive nits were applied.

## Open problems

1. **Spec text vs build (for the spec owner).** §3b item 3 says the author's answer carries "`holding` and `supersededBy` and nothing else". The build adds `delivered` + `messageIds` (only when the author sent it itself) and allows `holding: null` ("cannot tell"). Both are needed to close the row-6 hole and only make answers more exact or more cautious. The spec's row 6 should say "author not holding, has not replaced it, and did not deliver it itself".
2. **Depends on 3a for full effect.** No writer exists yet for `ownerVerdict`, `ownerUnstated`, `holderReason`, `duplicate-content` or `suppressed-at-holder`. Until 3a ships, every held author row reads as holding (row 7 `pending`) and every unreasoned suppression reads `unknown`. Both err cautious; F2's "owner ended it" case reads `pending` on the author until 3a records the owner verdict.
3. **Older owners.** An older owner refuses a third machine's reader ask; that reads `why: 'refused'`, not `old-version` (cannot be told apart on that path). Safe.
4. **Route deadline covers mesh asks only**, not local store reads across supersession hops; `routeOverBudget` measures it.
5. **Commit used the logged orphan-deferral override.** The lint flags 15 lines in the approved spec (copied unchanged from PR #3086): fixed user-facing strings ("Follow up here") and deferrals that name their registered CMT ids inline but not in `<!-- tracked: -->` form. The spec owner should add the markers on #3086; this PR did not edit the approved spec text.
6. **`RULE 3: EXEMPT` comment** added to `OriginOwnerRead.ts` after the last test run (comment only), because the state-detection gate matches the class name `OriginOwnerReader`.
7. **Live proofs not run** (the spec's 3b live proof on the real pool and the throwaway-pair holder-stopped proof). They belong to the test-agent-live and dev-agent-live rungs before and on the release day.
