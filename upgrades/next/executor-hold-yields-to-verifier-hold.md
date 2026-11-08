# A fix attempt no longer holds back a restart the test queue is waiting for

## What Changed
When the installed verifier changes on disk, Local Verify holds its queue until the server restarts. A feedback fix attempt in setup or final checks could defer that restart for up to two hours, leaving the test slot idle with work queued (fb-7459b8b6-a7f: 16.7 minutes idle with 11 queued on 2026-11-07). The executor's restart hold now stands aside while Local Verify reports a verifier hold with queued work, and writes an audit row saying so; the seconds-long publish window keeps its hold, because a restart there leaves the publication outcome unknown. The interrupted attempt is handled as before: ended as interrupted and re-claimable, or re-verified once when its files survived; never reported as a success. The two-hour hold is unchanged in every other case, and an unreadable Local Verify state keeps the hold.

## What to Tell Your User
Updates no longer wait behind a fix attempt when the pull-request test queue is itself waiting for that restart.

## Summary of New Capabilities
- The feedback executor's restart hold stands aside for a restart Local Verify's queued work needs.

## Evidence
Unit: tests/unit/localVerify/LocalVerifyService.test.ts (the reader on both sides), tests/unit/feedback-factory/execute-service.test.ts (hold kept, hold withdrawn with one audit row, publish window kept, unreadable state keeps the hold), tests/unit/feedback-factory/execute-wiring.test.ts (builder pass-through). Integration: tests/integration/feedback-github-runtime-routes.test.ts (a real AgentServer passes Local Verify's state into the executor). Live: fb-7459b8b6-a7f, Studio, 2026-11-07 15:54:51–16:11:35Z.
