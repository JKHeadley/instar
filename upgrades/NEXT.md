# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Notify-on-stop, Layer B: when the Unjustified Stop Gate judges a stop unjustified-but-unblockable (`continue` in shadow mode — the gate wants to keep going but shadow can't block, so the session silently stalls) or ambiguous (`escalate`), and the stopping session is **unattended** (an autonomous run), the user now gets one coalesced plain-English heads-up ("a background run stopped mid-task — want me to pick it back up?"). Previously the gate saw these and could do nothing the user could observe.

Tightly bounded to stay near-silent: only those two genuinely-stuck decision classes, only unattended sessions, at most once per session per 30 minutes, coalesced onto the single system (lifeline) topic. Routine turn-ends, blocked-and-continued stops, and transient fail-opens stay silent. Default ON (Justin's explicit "tell me why it stopped"); disable with `monitoring.notifyOnStop.enabled=false`.

Pairs with Layer A (autonomous-run terminal-exit notices). Together: a session either keeps going, or the user is told why it stopped.

## What to Tell Your User

- If one of my background runs stalls mid-task when it shouldn't have, you now get a single heads-up — even when the watchdog can't restart it itself.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Unjustified mid-task stalls on unattended sessions surface one coalesced Telegram | Automatic (default on); `monitoring.notifyOnStop.enabled=false` to disable |

## Evidence

- `src/monitoring/StopNotifier.ts` (decision matrix + attended-gate + dedup); wired via `src/server/routes.ts` (evaluate route), `src/commands/server.ts` (construction), `src/server/AgentServer.ts` (forward).
- Config: `monitoring.notifyOnStop` in `src/core/types.ts`.
- Tests: `tests/unit/StopNotifier.test.ts` (21) + `tests/unit/stop-notifier-wiring.test.ts` (6).
- Spec: `docs/specs/NOTIFY-ON-STOP-SPEC.md` (approved). Side-effects: `upgrades/side-effects/notify-on-stop-layer-b.md`.
