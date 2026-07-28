# Side-effects — Restart-when-idle (restart-window idle bypass)

## 1. What files/state does this touch at runtime?
`AutoUpdater.gatedRestart()` and `UpdateGate`. No new files, no config keys, no schema, no
persisted state added. The deferral record written on an *active* deferral now carries the actual
blocking session names (previously `[]`) — same record, richer field.

## 2. Does it change any functional behavior?
- **Agents with NO restart window configured:** none. `isInRestartWindow()` returns true when no
  window is set, so the window gate is never entered.
- **Agents WITH a restart window, while ACTIVE (a healthy session running):** none — still defers
  to the window exactly as before.
- **Agents WITH a restart window, while IDLE (no active sessions):** an update that lands outside
  the window now restarts immediately instead of waiting hours for the window. The restart is the
  same idle silent-restart the in-window path already performs.

## 3. What happens on failure / weird config?
The probe is best-effort and read-only. If no `sessionManager` is wired, the window gate treats it
as idle and falls through to the existing "no session manager → silent restart" path one block
down (consistent semantics). `getBlockingSessions` returns `[]` for zero sessions. No throw path
added.

## 4. Migration parity — do existing agents get it?
Yes, via the normal release — it is a **code-only** change compiled into `dist`. No
`PostUpdateMigrator` pass is needed because no agent-installed file (hook/skill/config/CLAUDE.md
template) changes. Existing agents pick it up when they update to this version.

## 5. Could it spam / flood / burn resources?
No. It adds one in-memory session classification (a list walk already done by `canRestart`) per
restart attempt. No new timers, no new I/O, no new network calls. If anything it *reduces* work by
skipping the deferral-timer scheduling on idle boxes.

## 6. Rollback / off-switch?
Revert the PR. The behavior is always-on (no flag) — idle restarts are inherently safe (they are
what idle agents already get inside the window), so the change is strictly a latency improvement.
A user who wants strict window-only behavior even while idle would need the reverted code; this is
documented as a deliberate trade-off, not an oversight.

## 7. Concurrency / ordering?
None new. The idle probe (`getBlockingSessions`) is pure and side-effect-free — crucially it does
NOT start or continue `UpdateGate`'s deferral clock or set warning flags (a dedicated purity unit
test guards this). The real restart guard remains the `canRestart()` call at the session gate,
which runs after the window gate; a session that becomes active between the two checks is caught
there and deferred.

## Blast radius
Small + additive. One conditional at the window gate in `AutoUpdater.ts` + one pure method
(`getBlockingSessions`) plus a behavior-preserving extraction (`classifyRunningSessions`) in
`UpdateGate.ts`. The existing restart gate (`canRestart`) is byte-for-byte unchanged and its
regression tests (cascade-dampener) stay green. Only affects agents that have a restart window
configured AND are idle when an update lands outside it.
