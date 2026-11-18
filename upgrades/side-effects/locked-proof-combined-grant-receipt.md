# Combined proof receipt boundary

Tier2 integration under approved docs/specs/desktop-locked-screen.md P12/P15, combining native/runtime and proof recovery changes; the new follow-up itself is narrowly scoped to harness evidence. Parent requested an actual openGrant deferred-response regression; it reproduced return before receipt. No production runtime edits in this follow-up.

## Evidence and behavior

Visible controls remain mandatory; then require approved exact-request UUID and future expiry within5s monotonic. Response listener still admits only successful approved exact GET /desktop/requests/:id. No fallback identity or expiry. Deferred-body, missing and expired receipt cases cover both sides; afterfix103/103 timing+driver tests pass. A prior name-filter invocation entered suite queue, was cancelled with no executed tests, and the explicitfile run used targetedlane.

## Side effects

Over-block: a browser response taking morethan5s now fails proof instead of producing incomplete evidence. Under-block: positive receipt cannot substitute for visiblecontrol; controls alone cannot substitute for receipt. Product grants, auth, native lock policy, helper signature/TCC and credentials are unchanged. No added user-message heuristic or authority; deterministic evidence gates this requested developer proof only.

## Composition

Merged cleanup preserves guard-ACK restore and watch supervisor recovery before server topology restoration. The watch prototype recover test now supplies inert restoreGuardAck; no other watch prototype prepare/recover fake exists. Duplicate grantRequestId assignment removed without changing the retained requestId/id compatibility expression. Full resolutions and merge SHAs are documented in /tmp/topic138345-combined-resolutions.md for parent handoff.

## Validation and rollback

Beforefix timingfile22pass/1reproducedfailure; afterfix timing+driver103pass. Parent review before finalcommit; broader checks/package build await owner decision. Revert this follow-up between proof runs; no migration or deployment. Existing source PRs untouched. No live Mac or Telegram action. Independent combined review handled by parent; commit/gate attempts recorded in final handoff.

## Exact integration lineage and resolutions

# Local combined source candidate

Branch fix/locked-proof-combined, worktree .worktrees/topic-138345-combined. Base23d7af053. Final merged source a74cc95db. No push/PR, no fullbuild/integration/E2E or explicit broadguard runs.

1. Next-grant62f57e558 ->513687606: clean automatic merge, preserving positive next-grant evidence.
2. Guard-ack55f58220c ->bcde71a4e: one driver response parsing formatting conflict; retained multiline expiresAt/requestId extraction, identical semantics.
3. Timing2671885ab ->4cac0d80c: response parsing overlap resolved in favor of successful approved exact GET /desktop/requests/:id. Both requestId and expiry come from that positive receipt; loose any-desktop JSON evidence discarded.
4. Watchba05bf2ff ->a74cc95db: prepare keeps native observeGuards=false plus confirmed watch recovery/archive before nextcase; preserves closeViewers and restoreGuardAck. recover preserves guard-ACK cleanup then watch supervisor handshake, returning before topology mutation unless independent recovery terminal. Retained suppression of generic lock-now forwatchfixture. Did not resurrect obsolete stopper interval cleanup (guard-ACK replaced that mechanism). Native final population/lock-call evidence and watch exact duty attention evidence both remain wired.

Watch release fragment converted on combined branch only from internal-only to full What Changed/Evidence/What to Tell Your User/Summary of New Capabilities headings because combined diff includes native/runtime files. Original watch PR unchanged.

Three conflict-resolution commits ran normal hooks; all54 lint checks each passed. Clean merge had normal git merge behavior. No hook bypass.

Next bounded check requested by parent: reproduce asynchronous approved-response-body vs visible-control race using actual openGrant; independent review before fix commit. Broader tests and package build remain awaiting owner decision.

Current main b1982746a merged cleanly as e66b4b15a after bounded receipt tests; adds only three frontier-review spec documents. Verified currentmain is now ancestor.

Bounded actual openGrant regression reproduced return-before-approved-body (22pass/1fail timingfile). Fix waits up to5s monotonic for positive request UUID/future expiry after visiblecontrol; missing/expired evidence refuses, no fallback. Afterfix timing+driver103/103 passed. One watch recover fake now supplies inert restoreGuardAck to avoid touching real fixture operations. Removed duplicate grantRequestId write, retaining original requestId/id compatibility assignment. These fivefiles form the reviewed integration follow-up.

Testing lane note: Vitest `-t` namefilter caused suite-lane classification despite one explicitfile. Verified and cancelled only own queued Vitest39772 via dedicatedlog fd+cwd; no tests executed there. Explicit filename without -t obtained targetedlane. Avoid -t on future bounded checks.

Actual combined test mapping: timing25 + driver78 =103 passing. No inferred total from separately run source-branch tests. Parent reviewed the receipt boundary and source approved-GET shape; independent final-delta concurrence is recorded before commit.

Final review: parent and independent proof_ack_gap concurred on the bounded receipt wait, exact approved GET shape and inert fake composition. Normal integration commit authorized before the affected combined unit-file batches; fullsuite, integration/E2E, package build, guard rerun and publication remain outside this step.

## Combined release-note gate follow-up

The normal first push stopped before tests/publication because the inherited guard-ACK and next-grant fragments were also internal-only beside the combined runtime diff. Their markers are now removed and complete user/capability headings added on this combined branch only, matching the already converted watch fragment. This is documentation-only; no executable source, tests, helper, configuration or artifact bytes change. Existing source PRs remain intact. The local proof package remains exactly from3a3c6b963; the later documentation commit does not claim a new package build. Revert these note edits if separating the combined changes again. No additional tests are warranted for release prose; normal commit/push gates still run.
