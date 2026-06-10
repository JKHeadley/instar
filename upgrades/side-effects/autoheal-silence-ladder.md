# Side-effects review — Auto-heal ladder (ActiveWorkSilenceSentinel)

## Scope of change

Extends the existing `ActiveWorkSilenceSentinel` (silent-freeze watchdog) with a
dark-by-default auto-recovery ladder and routes its notices to the stalled
session's own topic. Touched src files:

- `src/monitoring/ActiveWorkSilenceSentinel.ts` — `SilenceStatus` gains
  `recovering` / `recovery-failed`; `SilenceState.recoveryAttempts`; deps gain
  optional `recoverFn`; config gains `autoRecover` (default false) +
  `maxAutoRecoveries` (default 1); `escalate()` now branches to `runRecovery()`
  when `autoRecover && recoverFn && recoveryAttempts < maxAutoRecoveries`; new
  `runRecovery()` ladder (notify → respawn → notify outcome; emits
  `recovering`/`recovered`/`recovery-failed`/`recover-error`).
- `src/monitoring/sentinelWiring.ts` — `buildActiveWorkSilenceDeps` gains
  optional `recoverFn`, `getTopicForSession`, `deliverToTopic`; `notifyFn` now
  routes to the session's own topic, falling back to the consolidated `escalate`
  path when the topic can't be resolved OR delivery returns false.
- `src/commands/server.ts` — wires `recoverFn` (gated on `autoRecover`, via the
  same `_sessionRefresh.refreshSession({fresh:true})` primitive ContextWedge
  uses), `getTopicForSession` (telegram), `deliverToTopic` (POST
  `/telegram/reply/:topicId`), and the new ladder event recorders.
- `src/core/types.ts` — config type fields `autoRecover` + `maxAutoRecoveries`.
- `src/config/ConfigDefaults.ts` — comment-only; `autoRecover` deliberately NOT
  persisted (see Migration Parity below).
- `src/monitoring/SentinelNotifier.ts` — adds `recovering` to `SentinelEventKind`
  for the audit trail.

## Blast radius

The only behavioral path that DESTROYS state is `recoverFn` → fresh respawn.
It is reachable ONLY when `monitoring.activeWorkSilenceSentinel.autoRecover ===
true` (off by default) AND a session is confirmed silent past the threshold AND
a nudge failed to advance output. The respawn uses `fresh:true`, preserving the
conversation via `--resume` (same semantics ContextWedge already relies on in
production). When `autoRecover` is off, the only behavior change from before is
the notice ROUTING (see below) — no respawn ever occurs.

## Notice-routing behavior change (applies even when autoRecover is OFF)

Previously every silence escalation went through `notifier.escalate` →
consolidated lifeline feed. Now `notifyFn` first tries the stalled session's own
topic (`getTopicForSession` → `deliverToTopic`), and falls back to `escalate`
only when the topic is unresolved or delivery fails. This is the operator's
explicit ask ("messages should only go to the topic that's stalled").

- **Tradeoff (flagged for the promotion review):** the per-session route posts
  via `/telegram/reply/:topicId`, which does NOT pass through the consolidated
  tone-gate / attention-topic anti-flood budget the `escalate` path uses. For a
  fixed-template, low-frequency sentinel notice this is acceptable, and the
  volume is intrinsically bounded (one detect + at most one recovery per stuck
  session, and a stuck session is rare). The fallback path is still the
  anti-flood-guarded `escalate`. If auto-heal is ever promoted to fire at higher
  volume, revisit whether the per-session route needs its own rate cap.

## Loop / runaway analysis

- `maxAutoRecoveries` (default 1) caps respawns per session. The cap is enforced
  twice: the `escalate()` guard (`recoveryAttempts < maxAutoRecoveries`) and the
  fact that a failed recovery sets status `recovery-failed` WITHOUT clearing
  state — so `tick()`'s `if (existing) continue` (already-tracked skip) prevents
  re-detection. A session that stays stuck after one respawn is asked-about once
  and then left alone, never re-respawned. Unit-tested explicitly
  ("loop cap: respawned at most once").
- A SUCCESSFUL recovery clears state so the freshly-respawned session is
  monitored anew; the respawn resets its output clock so it won't immediately
  re-trigger.

## Framework generality

`recoverFn` delegates to `_sessionRefresh.refreshSession`, which respawns
whatever framework the session runs (claude-code / codex / others) — it does not
assume Claude. No framework-specific branching is introduced. The notice text is
plain-English and framework-neutral.

## Migration parity

No agent-installed file changes (no `.claude/settings.json` hooks, no hook
scripts, no CLAUDE.md template section, no persisted config default). `autoRecover`
is intentionally OMITTED from `ConfigDefaults` (mirroring
`contextWedgeSentinel.autoRecovery`): `applyDefaults()` is add-missing-only, so
persisting `false` now would freeze it and block a future default-on flip from
reaching existing agents. The dark default lives as the runtime check in
server.ts. New and existing agents get identical (off) behavior. Promotion to
default-on = flip the runtime check + add the persisted default (documented in
the ConfigDefaults comment).

## Test coverage

- `tests/unit/monitoring/ActiveWorkSilenceSentinel.test.ts` (+6): autoRecover
  off → ask (no respawn); on + success → respawn once, notify, clear; on +
  failure → recovery-failed, ask, keep state; loop-cap → at most one respawn;
  recoverFn throws → recover-error + ask.
- `tests/unit/monitoring/sentinelWiring.test.ts` (+5): notifyFn routes to the
  session topic; falls back to escalate when topic unresolved; falls back when
  delivery fails; recoverFn passthrough present-vs-undefined.
- Existing unit/integration/e2e silently-stopped suites stay green.
