# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**The SessionReaper now reaps under CPU pressure, not only memory — and keeps a
silent, reviewable record of every decision it makes.**

The idle-session reaper used to compute its pressure tier purely from free
memory. But on a busy multi-agent box the real squeeze is almost always CPU, not
RAM (free memory can look fine while the load average is well past the core
count). So an idle session could sit holding CPU baseline indefinitely and the
reaper, watching only memory, would never wake up.

Pressure is now the WORST of two signals: memory (free %) and CPU (1-minute load
average ÷ core count). A CPU-bound box raises the tier even when memory is fine,
so genuinely-idle sessions become eligible under load — while the reaper's
positive-idle proof, hysteresis, confirmation window, rate limits, and grace
period are all unchanged, so it still never reaps a working session. The two CPU
thresholds are configurable; sensible defaults ship (moderate at 1.0 load per
core, critical at 1.5), and a transient build spike won't trigger a reaping spree
because the existing 3-observation confirmation smooths it.

Second, the reaper now writes a dedicated decision audit trail. Previously its
structured events were mixed into the shared sentinel log and only covered the
reap path — there was no record of the routine keep decisions, so "what is the
reaper considering, and why?" had no grounded answer. It now logs every keep/kill
decision change (on transition, not every tick, so a multi-day kept session logs
once) plus the reap-path events, each stamped with the pressure tier that drove
it, to a dedicated file readable through a new read-only endpoint.

## What to Tell Your User

Nothing to configure. Your idle-session cleanup is now aware of CPU load, not
just memory — so on a busy machine it can finally relieve pressure that free
memory alone would have hidden. It is still just as careful: it never touches a
session that might be working. You can also now ask me what the cleanup is
considering and why it kept or shut down any session — there is a quiet,
inspectable decision log behind it. None of this sends you notifications; it is
all there for when you want to look.

## Summary of New Capabilities

- Reaper pressure is CPU-aware: tier is the worst of memory (free %) and CPU
  (1-min load ÷ cores), via the new pure `computePressure()` classifier.
- Two new tunable thresholds: `cpuModerateLoadPerCore` (default 1.0) and
  `cpuCriticalLoadPerCore` (default 1.5) under `monitoring.sessionReaper`.
  Existing agents receive them automatically via the canonical config defaults.
- `GET /sessions/reaper`'s `pressure.inputs` now exposes `freePct`,
  `loadPerCore`, and the `memTier`/`cpuTier` breakdown.
- New read-only endpoint `GET /sessions/reaper/audit?limit=N` returns the tail
  of the dedicated decision trail at `logs/reaper-audit.jsonl`.
- A `decision` audit row is written on first sight and on every (verdict,
  keptBy) change — transition-only, so no per-tick log spam. Silent: no Telegram,
  no attention items.

## Evidence

- `tests/unit/session-reaper-pressure-audit.test.ts` — new: `computePressure`
  (memory-only when cores unknown, CPU-raises-tier, worst-of combos, custom
  thresholds, non-finite load ignored); the `reaperAuditSink`/`readReaperAudit`
  round-trip (bounded tail, `[]` when absent); and the transition-only decision
  audit (logs on first sight + on change, not when unchanged).
- `tests/integration/session-reaper-routes.test.ts` — new: `GET
  /sessions/reaper/audit` returns 200 with the tail, honors `?limit`, and `[]`
  when no trail exists.
- `tests/e2e/session-reaper-lifecycle.test.ts` — new Phase-1 "feature alive"
  test: the audit route returns 200 (not 503) through the real AgentServer
  plumbing and reads a written row back.
- `tests/unit/feature-delivery-completeness.test.ts` + `capabilities-discoverability.test.ts`
  green: migrator parity (new `migrateClaudeMd` section), config parity, and
  route classification all satisfied.
- Full `npm run lint` + the reaper test tiers pass.
