## What Changed

The idle-session reaper could identify a session as safe to clean up but never actually close it, because the close path re-applied a guard the reaper had already accounted for. Specifically, `SessionReaper.evaluate()` relaxes the `active-process` keep-veto for a session it has proven idle (CPU-flat under pressure, or 8h-stale with only its own idle children such as the standing MCP servers), reaches `reap-pending`, and calls `terminate()` — but `SessionManager.terminateSession` re-ran the shared, un-relaxed `ReapGuard` and re-vetoed with `active-process`. The reap was attempted and refused on every tick (observed live: 1,532 consecutive `skipped:active-process`), so idle sessions accumulated and over-subscribed the host.

This adds a scoped `bypassActiveProcessKeep` option on `terminateSession`, set by the reaper only on a reap whose `active-process` veto it relaxed. It lifts only the `active-process` keep-reason; every other guard (recent user message, open commitment, active subagent, protected, lease-holder, in-flight) is re-checked by the authority and still vetoes. It mirrors the existing `bypassRecoveryFlag` contract. Default behavior (no flag) is unchanged.

## What to Tell Your User

Idle conversation sessions that had gone quiet now actually get cleaned up to free your machine, instead of piling up. Previously the cleanup noticed they were idle but could never close them, because every session keeps always-on tool helpers attached and the safety check treated those as "still busy." Nothing is lost when a session is cleaned up — its conversation is saved and resumes exactly where it left off the next time that topic is messaged. The change is conservative: a session is only closed after it has been silent for hours with a still screen and no new activity, and a session doing real work is still kept.

## Summary of New Capabilities

- The reaper can now complete the cleanup of a long-idle session whose only remaining "activity" is its standing tool-server stack, rather than being blocked forever by the safety guard.
- No new settings to configure; the behavior rides the already-shipped stale-idle and CPU-aware relaxation flags.

## Evidence

- Root cause confirmed against live state (dist v1.3.448): reap-log showed 1,532 `skipped:active-process` plus 173 correctly-kept `skipped:open-commitment`, while the reaper-audit showed `reap-pending` rows for the same sessions — the reaper authorizing reaps the authority then refused.
- Tests (all green, 115 across 7 suites): unit coverage that the reaper passes the flag only when it relaxed the veto and that the authority honors it scoped to `active-process` alone (a different keep-reason still vetoes even with the flag); an integration test wiring the real reaper and real `terminateSession` together to prove they agree end-to-end; the e2e reaper lifecycle test remains green.
