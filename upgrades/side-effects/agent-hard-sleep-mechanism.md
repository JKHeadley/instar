# Side-Effects Review — Agent hard-sleep stop+wake mechanism (Stage B, slice 2)

**Version / slug:** `agent-hard-sleep-mechanism`
**Date:** `2026-05-31`
**Author:** `echo`
**Second-pass reviewer:** `adversarial review performed — found a critical brick (wake-trigger gated on health) + a broken manual escape hatch; BOTH fixed + tested before commit. Concurs the dark code is inert. Enablement remains the reviewed gate (live on a test agent with Justin watching).`

## Summary of the change

Acts on the slice-1 SleepController verdict: in live mode it writes
`state/sleep-requested.json`; the ServerSupervisor honors it by stopping the server
tmux session and entering a `slept` state; the health loop then short-circuits
(suppressing auto-respawn) and only watches for `state/wake-requested.json`, which
the TelegramLifeline writes on the next inbound message → the supervisor respawns
the server and the existing forward-retry queue replays the buffered message. Files:
`SleepController.ts` (+`sleepRequestWriter`), `ServerSupervisor.ts`
(checkSleepRequest/checkWakeRequest/`slept` guard/boot-marker), `TelegramLifeline.ts`
(+`requestWakeIfSlept` via the pure `agentSleepWake.ts` helper). No new config (the
slice-1 `monitoring.agentSleep` gates it), no new route, no agent-installed file.

## Decision-point inventory

- `ServerSupervisor` health-loop control flow — modify — adds ONE short-circuit: `if (slept) { checkWakeRequest(); return; }` at the loop top.
- `ServerSupervisor.checkSleepRequest` / `checkWakeRequest` — add — the stop/respawn handlers (mirror checkRestartRequest).
- `ServerSupervisor` boot — modify — reads `slept-marker.json` to stay asleep across a supervisor reboot.
- `SleepController.requestSleep` consumer — add — `sleepRequestWriter` (live-mode only).
- `TelegramLifeline.forwardToServer` — pass-through — prepends a non-blocking `requestWakeIfSlept()` side-call.

---

## 1. Over-block

No block/allow surface over messages. The only "blocking-like" behavior is the
`slept` short-circuit suppressing auto-respawn — which is exactly intended and gated
on `slept`, set only after a live sleep-request is honored. A genuine crash (slept
=== false) still flows through the unchanged `evaluateUnhealthyServer` path.

## 2. Under-block

Could the server fail to wake (the brick risk)? **The adversarial second-pass review
caught a real brick in the first cut and it was fixed:** the wake-trigger was
originally placed inside `forwardToServer()`, which is gated on `supervisor.healthy`
— but a slept server is not healthy, so an inbound message took the "server down →
queue" path and never wrote `wake-requested.json` → the server would never wake.
**Fix:** `requestWakeIfSlept()` now runs at the TOP of `processUpdate()`, before any
health gate, so EVERY inbound update writes the wake flag when slept (covered by the
helper test + the corrected call-site). The review also caught that `/lifeline
restart` (the manual escape hatch) didn't clear the slept-marker, so a manual restart
re-read the marker and re-slept — **fixed** via `ServerSupervisor.wakeFromSleep()`,
called from both `/lifeline restart` and `/lifeline reset` (tested).

Remaining wake robustness: the supervisor checks the wake flag every 10s while slept;
a single missed flag write self-heals on the next inbound; a fleet-watchdog mid-sleep
bounce stays asleep via the boot-marker AND wakes on the next inbound. The
scheduler-wake (a cron job due during sleep) is the one tracked gap (conservative-null
for now), enablement-gated — dark default means no real agent is affected.

## 3. Level-of-abstraction fit

Correct. The mechanism reuses the proven `restart-requested.json` lifecycle shape
(file flag consumed in the health loop) rather than inventing a new lifecycle; the
stop is the existing tmux `kill-session`, the wake is the existing `spawnServer()`.
The lifeline wake-trigger is extracted into a pure, unit-tested helper
(`writeWakeRequestIfSlept`) rather than buried in the un-testable heavy class.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — the SleepController remains the decision-maker (signal, with all guards);
  this slice is the mechanism it drives. The stop IS an authority (stops a process),
  but it is gated exactly like a planned restart: positive proof (the slice-1
  would-sleep verdict with every guard), ships OFF + dry-run, never fires unless
  enabled && !dryRun, and KEEPs-awake on any ambiguity upstream.

## 5. Interactions

- **Shadowing:** the `slept` short-circuit runs before the health/restart logic; it
  is a no-op when `slept===false` (always, until a live sleep-request lands), so it
  cannot shadow the existing restart/health paths in normal operation. Verified by
  the unchanged `ServerSupervisor-handshake` + `supervisor-health-check` suites.
- **Double-fire:** sleep is idempotent (`checkSleepRequest` early-returns when
  already slept); wake is idempotent (early-returns when not slept). The
  `sleep-requested`/`wake-requested` flags are consumed on read.
- **Races:** the fleet watchdog vs sleep — resolved by the boot-marker (reboot stays
  asleep). The lifeline writing a wake flag while the supervisor is mid-respawn —
  harmless (the supervisor clears `slept` first, so a redundant wake flag is consumed
  next tick as a no-op).
- **Feedback loops:** none — the flags are one-shot, consumed by the consumer.

## 6. External surfaces

- **Install base:** pure additive source, no config/route/agent-installed-file
  change → every agent picks it up on update; behavior is byte-identical until
  `monitoring.agentSleep` is enabled live. The slice-1 dark default holds.
- **Other agents / external systems:** none.
- **Persistent state:** three transient `state/*.json` flags + one `slept-marker.json`
  (best-effort, consumed/removed by the supervisor).
- **Timing:** the existing 10s health tick; no new timer.

## 7. Rollback cost

Pure additive code, no config/migration. Revert → `checkSleepRequest` /
`checkWakeRequest` / the `slept` guard / the lifeline side-call disappear; the
supervisor + lifeline behave exactly as before. No persistent state needs cleanup
(the flags are transient). No user-visible change during rollback (dark by default).

## Conclusion

This review confirmed the mechanism is a tightly-scoped, additive layer on the
proven restart lifecycle, with ONE load-bearing change (the `slept` short-circuit)
that is a no-op until a live sleep-request is honored and is regression-covered by
the existing supervisor suites. The brick risk is closed at multiple layers
(per-forward wake re-write, 10s wake poll, boot-stay-asleep marker). It ships dark;
the enablement (turning sleep ON) is the reviewed validation step on a test agent.
