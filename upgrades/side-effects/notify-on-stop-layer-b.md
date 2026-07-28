# Side-Effects Review — Notify-on-Stop, Layer B (gate-fed unjustified-stall notice)

**Spec:** docs/specs/NOTIFY-ON-STOP-SPEC.md (approved: true) — Layer B of two. Layer A (autonomous-run-ended notice) shipped in a prior PR.

When the UnjustifiedStopGate (shadow/enforce) classifies a stop as unjustified-but-unblockable (`continue` in `shadow` — the gate wants to continue but shadow can't block, so the session silently stalls) or ambiguous (`escalate`), an UNATTENDED session can go quiet mid-task and the user never hears about it. Layer B turns those specific classifications into ONE coalesced heads-up.

## What changed
- `src/monitoring/StopNotifier.ts` (new) — thin DECISION layer: `isNotifyWorthyStop` (shadow+continue OR escalate; everything else silent) + attended-gate (unattended/autonomous only, default) + per-session dedup (30-min cooldown) + master enable (default ON). Delivery is delegated to an injected `escalate` sink.
- `src/commands/server.ts` — constructs a dedicated `SentinelNotifier` (telegramEscalation **on** — distinct from the housekeeping sentinel notifier, which stays default-off) reusing the lifeline-topic `sendConsolidated` transport + a JSONL log; wraps it in a `StopNotifier`. Null when telegram isn't wired or config disables it.
- `src/server/routes.ts` — the `/internal/stop-gate/evaluate` route computes `autonomousActive` (via `getHotPathState`) and, after the authority decision, calls `ctx.stopNotifier?.maybeNotify({ sessionId, mode, decision, autonomousActive })`. Fire-and-forget; never affects the gate decision or the HTTP response.
- `src/server/AgentServer.ts` — accepts + forwards `stopNotifier` to the routes ctx.
- `src/core/types.ts` — `monitoring.notifyOnStop?: { enabled?, unattendedOnly?, cooldownMs? }`.
- Tests: `StopNotifier.test.ts` (21 — both sides of every decision boundary, attended-gate, dedup window/expiry/per-session, master gate, throwing-sink safety) + `stop-notifier-wiring.test.ts` (6 — route→notifier→sink→server→AgentServer chain, guards the PR#334 dead-code failure mode).

## Signal vs authority
The Stop-hook router is a dumb thin client; the decision to ALARM the user lives server-side in StopNotifier, where the gate decision + attended-state + dedup ledger all exist. StopNotifier adds NO blocking authority — it's a delivery decision only. It never changes the gate's `decision`.

## Near-silent compliance
Default-on is the deliberate exception Justin explicitly asked for ("tell me why it stopped"), and it is tightly bounded: only two genuinely-stuck decision classes, only unattended sessions, at most once per session per 30 min, coalesced into one message on the single lifeline topic. Routine turn-ends (`allow`), blocked-and-continued (`continue` in enforce), continue-ceiling (`force_allow`), and fail-open are all silent. A single config flag (`monitoring.notifyOnStop.enabled=false`) kills it with no redeploy.

## Over/under-notify
- OVER: a shadow-mode `continue` could occasionally be a gate misjudgment (the CONTINUE_CEILING exists because the authority can be wrong). Mitigated by attended-gate + 30-min dedup; the alternative (a silent autonomous stall) is exactly what Justin wants eliminated.
- UNDER: when the gate is `off` (no evaluate call) there's no Layer B notice — but Layer A still covers autonomous terminal exits, and the gate runs in `shadow` on real agents.

## Migration parity
Default-on works WITHOUT any config key present (`enabled !== false` ⇒ true when undefined), so existing agents get it on update to this version with no migrateConfig step. The wiring is server-side; no agent-installed-file change.

## Rollback
`monitoring.notifyOnStop.enabled=false` (instant, no redeploy) or revert the 6 files + 2 tests.

## Tests / verification
- Tier 1 unit: StopNotifier.test.ts (decision matrix both sides + gates).
- Wiring-integrity: stop-notifier-wiring.test.ts (no dead code).
- Tier 3 live: test-as-self before merge — drive a synthetic shadow+continue on an autonomous session through the real route and confirm the lifeline-topic heads-up fires once (and a routine `allow` stays silent).
