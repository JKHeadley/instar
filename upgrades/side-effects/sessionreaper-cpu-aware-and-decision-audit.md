# Side-Effects Review — SessionReaper CPU-aware pressure + decision audit

**Version / slug:** `sessionreaper-cpu-aware-and-decision-audit`
**Date:** `2026-05-30`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

The idle-session reaper's pressure tier was computed from free memory only. This
change makes it the WORST of memory (free %) and CPU (1-min load ÷ cores) via a
new pure `computePressure()` classifier, with two tunable thresholds
(`cpuModerateLoadPerCore` 1.0 / `cpuCriticalLoadPerCore` 1.5) auto-migrated to
existing agents. It also adds a silent decision audit: every keep/kill decision
*change* + the reap-path events land in `logs/reaper-audit.jsonl`, served
read-only at `GET /sessions/reaper/audit`.

## Decision-point inventory

- **Pressure tier computation** (existing decision, widened): now also keys on CPU
  load. Gates *when* the reaper may consider acting.
- **Decision audit emission** (new, zero-authority signal): writes an observability
  row on `(verdict, keptBy)` transitions. No control-flow effect.

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

CPU-awareness can raise the tier from `normal` to `moderate`/`critical` during a
load spike, making genuinely-idle sessions eligible sooner. It cannot cause a
*working* session to be reaped: the kill path still requires the full positive-idle
proof, transcript-stasis, render-stasis, 3-observation hysteresis over the
confirmation window, the two-phase reap, and the per-tick/per-hour budget — all
unchanged. A transient build spike is smoothed by the multi-observation
requirement. Default thresholds (1.0/1.5 load-per-core) are deliberately at/above
full subscription so "moderate" means genuinely oversubscribed.

## 2. Under-block

**What failure modes does this still miss?**

`os.loadavg()` is a trailing 1-minute average, so a very brief CPU famine may not
register, and a famine caused by non-session processes still only lets the reaper
trim *idle* sessions (it cannot reduce the load of the busy processes themselves).
This is acceptable — the reaper is one lever among several (load-shed, hosting
migration, tool/agent sleep); it is not meant to be a complete CPU governor.

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. Pressure sensing belongs in the reaper's injected `pressure()` provider; the
pure classifier lives next to the reaper and is unit-tested without `os`. The audit
is a sink/reader pair beside the existing `fileAuditSink`, mirroring the
`/sessions/reap-log` read-surface pattern. No business logic leaks into routes.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

No new blocking authority. The reaper remains the authority it already was; this
change does not add a brittle check that gates behavior — it widens an existing,
heavily-confirmed kill path's *eligibility window*, and every safety gate still has
to clear independently. The decision audit is a pure signal producer (write-only
observability) with zero authority. `computePressure` is total: unknown/non-finite
CPU input degrades to the prior memory-only behavior rather than failing.

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- Reads the same `monitoring.sessionReaper` config block; two additive fields.
- `reapNotify`, the reap-log (`/sessions/reap-log`), and the silently-stopped
  sentinels are untouched; the new audit writes a SEPARATE file
  (`reaper-audit.jsonl`), so nothing reading `sentinel-events.jsonl` is affected.
  (Reaper events previously co-mingled there now route to the dedicated file —
  reviewed: no consumer filters `sentinel-events.jsonl` for `kind:'session-reaper'`.)
- Migration: canonical config defaults (`applyDefaults` deep-merge) + a
  content-sniffed `migrateClaudeMd` section; both idempotent.

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

One new read-only HTTP route (`GET /sessions/reaper/audit`, Bearer-auth, classified
in the capabilities-discoverability lint). `GET /sessions/reaper`'s `pressure.inputs`
gains `loadPerCore`/`memTier`/`cpuTier` fields (additive). One new on-disk file
(`logs/reaper-audit.jsonl`). No Telegram, no attention items, no notifications.

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Cheap and layered. (a) Operationally, set the CPU thresholds absurdly high to
neutralize CPU-awareness with no deploy; the audit is write-only and harmless to
ignore. (b) A full revert of the PR restores the prior behavior exactly (the change
is additive). No data migration, no schema change, no irreversible state.

## Conclusion

Low-risk, additive, reversible. The safety-critical "never reap a working session"
contract is untouched; the change only widens *when* the existing gated path may
act and adds zero-authority observability. Ships behind the reaper's existing
OFF + dry-run default.

## Second-pass review (if required)

Not required — additive change, no new blocking authority, safety classifier
untouched.

## Evidence pointers

- `tests/unit/session-reaper-pressure-audit.test.ts` — `computePressure` matrix,
  transition-only decision audit, sink/reader round-trip.
- `tests/integration/session-reaper-routes.test.ts` — `GET /sessions/reaper/audit`.
- `tests/e2e/session-reaper-lifecycle.test.ts` — Phase-1 feature-alive for the
  audit route through the real AgentServer.
- `tests/unit/feature-delivery-completeness.test.ts` + capabilities-discoverability
  lint — migration + route-classification parity.
- `upgrades/NEXT.md` — upgrade guide.
