# Side-effects review — heartbeat no-silent-fallbacks ratchet fix

## Change

Comment-only. Adds `@silent-fallback-ok` exemption markers (with written
justifications) to three fail-safe `catch` blocks introduced by the
autonomous-progress-heartbeat feature:

- `src/monitoring/AutonomousProgressHeartbeat.ts` — heartbeat send-failure catch
  (already surfaced via `recordSuppressed` + `send-error` event).
- `src/monitoring/AutonomousProgressHeartbeat.ts` — `mostRecentOutboundAt`
  history-read catch (fail-closed sentinel return).
- `src/core/AutonomousSessions.ts` — `readAutonomousRunMarkers` state-file read
  (a missing `.local.md` is the expected no-run case; null is normal control flow).

## Side effects

- **Runtime behavior:** NONE. The edits are inside comments only; no executable
  line changed. `tsc` is unaffected (comments).
- **Tests:** `tests/unit/no-silent-fallbacks.test.ts` count returns from 479 to
  476 (== baseline), so the ratchet passes. No other test is touched.
- **Config / migrations:** none. No agent-installed file changes; no
  CLAUDE.md/template/hook/skill changes; no PostUpdateMigrator change needed.
- **External operations:** none. No network, no fs writes, no session spawns.
- **Security:** none. The exemptions document why each catch is fail-safe; they
  do not weaken any error path — the errors were already surfaced or fail-closed.

## Signal vs authority

N/A — no decision/gating surface changes. The exemption markers are a static
lint annotation read only by the ratchet test.

## Rollback

Revert the commit; the three comments disappear and the ratchet returns to 479
(which is exactly the pre-fix CI-red state). No data or state to unwind.
