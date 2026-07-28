# Side-Effects Review — Notify-on-Stop, Layer A (autonomous-run-ended notice)

**Spec:** docs/specs/NOTIFY-ON-STOP-SPEC.md (approved: true) — Layer A of two. Layer B (gate-fed unjustified-stop notice) ships as a separate PR.

Closes the primary silent-stall scenario: an autonomous run reaching a terminal exit (completion / duration-expiry / emergency-stop) previously only echoed the reason to stderr — the terminal the user can't see — so the run could end in silence unless the agent *remembered* to send a final report (willpower, not structure). Justin's standing requirement: a session either keeps going OR tells you why it stopped.

## What changed
- `.claude/skills/autonomous/hooks/autonomous-stop-hook.sh` — added two helpers (`goal_snippet`, `notify_terminal_stop`) and a `notify_terminal_stop "<plain message>"` call before EACH of the six terminal exits (native-mode emergency + duration; legacy duration, emergency, completion-condition, completion-promise). Each sends ONE plain-English Telegram to the run's `report_topic` via `telegram-reply.sh` — the same transport the existing restart-resume recovery note uses.
- `src/core/PostUpdateMigrator.ts` — bumped the autonomous-stop-hook capability marker from `Native /goal delegation` to `notify_terminal_stop` so existing agents on a prior stock hook receive the notify-enabled version on update (the marker+fingerprint mechanism; customized hooks left untouched).
- `tests/unit/autonomous-stop-hook-notify.test.ts` — static wiring (helper defined + called at all 6 exits), functional delivery (runs the REAL extracted helper against a stub telegram-reply.sh; both no-op gates), and migration (a stock pre-notify hook gains `notify_terminal_stop`).

## Behavior / safety
- **Best-effort, non-blocking:** `notify_terminal_stop` ends every path with `|| true` and returns early if there's no report topic or the channel isn't telegram. A delivery failure NEVER changes the hook's exit code or blocks the terminal exit.
- **Fires at most once per run:** every terminal branch removes the state file immediately after, so the hook can't re-enter and re-notify.
- **No new transport / topic:** reuses `telegram-reply.sh` to the run's existing report topic. No new Telegram topic is ever created.

## Over/under-notify
- OVER: at completion, the agent's own final report (if it sent one) plus Layer A's brief "run finished" backstop = a possible second short message. Accepted — the structural guarantee that *something* is sent outweighs minor redundancy; the backstop is one line.
- UNDER: a heavily-customized hook (no stock fingerprint) won't receive the migration — same accepted limit as every autonomous-hook migration. Channel != telegram → no send (Layer A is telegram-scoped; other channels await Channel Parity).

## Near-silent compliance
An autonomous run ending is an action-relevant, once-per-run event — exactly the kind the user asked to be told about. Not routine churn. No throttling needed (one message per terminal exit, max once per run).

## Migration parity
`migrateAutonomousStopHookTopicKeyed` (marker bump) ships the updated hook to existing agents; new agents get it via the bundled file at init. Verified by the migration test.

## Rollback
Revert the hook edits + the marker bump (2 files) + the test. Worst case: terminal exits go back to stderr-only.

## NOT in this PR (tracked)
- Layer B: gate-fed unjustified-mid-task-stop notice via the stop-gate evaluate route + a StopNotifier reusing SentinelNotifier's coalescing sink. Separate PR under the same spec.
