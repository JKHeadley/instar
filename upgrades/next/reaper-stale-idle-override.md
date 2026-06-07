<!-- bump: patch -->
<!-- change_type: fix -->

## What Changed

The idle-session reaper's `active-process` veto ("never reap a session with any live
child") is now staleness-aware, completing the chain after #955. A session with no
user message within the staleness window (default lowered to 8h) is treated as
abandoned, so its OWN idle children (e.g. idle MCP servers) stop shielding it. Found
because a post-#955 dry-run showed idle sessions just moved from keep-reason
`open-commitment` to `active-process` — and the MCP reaper correctly won't kill an MCP
server under a live session, so idle-MCP-heavy sessions sat in a gap.

The session must STILL be positively idle + producing no transcript output + confirmed
across multiple ticks to actually reap — this only drops the "it has idle children"
shield for an 8h-silent session. Also lowers the shared staleness window from 24h → 8h
(operator: restarts are cheap, prefer free resources), covering both this and the #955
commitment override.

New `monitoring.sessionReaper.reapStaleIdleWithActiveChildren` (default true);
`staleCommitmentWindowMinutes` default 480 (8h).

## What to Tell Your User

Nothing required — internal reaper policy, reaper still opt-in. For operators enabling
the reaper: a session silent for 8h+ that's sitting idle and producing nothing will now
become reap-eligible even if it still has idle MCP servers running. Active runs and
anything producing output are untouched.

## Summary of New Capabilities

- `reapStaleIdleWithActiveChildren` (default true) — relaxes the active-process veto for
  an 8h-silent, positively-idle, transcript-flat session so its idle children stop
  pinning it. Audited via a `staleIdleRelaxed` flag.
- Staleness window default 24h → 8h (one knob; covers commitment + idle-session vetoes).

## Scope (honest)

Third and final unblock in the chain (#952 Spotlight, #955 stale-commitment, this). Makes
idle sessions reap-ELIGIBLE; the opt-in reaper (dry-run first) acts on them. Pairs with
enabling sessionReaper + mcpProcessReaper + SleepController (were off fleet-wide). Leaves
the terminate-time authority guard conservative.

## Evidence

`tests/unit/session-reaper.test.ts` + `tests/unit/reap-guard.test.ts`: reaps a stale-idle
idle-child session (flags staleIdleRelaxed); keeps when not stale, when the flag is off,
when not positively idle (safety after relax), and when no bound topic; commitment
override tests updated to default-robust window mocks. 54/54 green. `tsc --noEmit` clean.
