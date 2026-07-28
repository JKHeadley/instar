# Side-Effects Review — SessionReaper CPU-aware active-process keep

**Version / slug:** `reaper-cpu-aware-keep`
**Date:** `2026-06-03`
**Author:** `echo`
**Second-pass reviewer:** `not required (reaper-only, dark-by-default, no new external surface)`

## Summary of the change

Under CPU pressure, the reaper's `active-process` existence-veto additionally
requires positive descendant-CPU progress (sampled across ticks via the #706
`descendantCpuSeconds` helper). A CPU-flat child no longer keeps an idle session
un-reapable; the reaper falls through to its existing transcript-growth +
positive-idle checks. Gated by `cpuAwareActiveProcessKeep` (dark; dev agents on
via `developmentAgent`). Reaper-only — the shared `ReapGuard`/`ReapAuthority`
path is untouched.

## Decision-point inventory

1. **Pressure gate** — `tier === 'normal'` ⇒ never tighten. Off-load behavior is
   byte-for-byte unchanged.
2. **CPU-flat threshold** — `ratePerSec < cpuActiveMinRatePerSec` (default 0.02).
   Below ⇒ "flat" (relax the veto); at/above ⇒ working (veto stands).
3. **Can't-tell ⇒ KEEP** — feature off, dep absent, sample error, non-finite read,
   first sighting (no prior delta), or CPU went backwards ⇒ `undefined` ⇒ the veto
   is NOT relaxed.
4. **Scope of relaxation** — only `blocked.reason === 'active-process'` is relaxed.
   Every earlier keep-reason (protected, recovery, recent-user, commitment,
   subagent, structural-long-work, …) returns first and is never affected.
5. **Fall-through, not kill** — relaxing the veto does not reap; the stateful
   transcript-growth + positive-idle gates (then hysteresis + two-phase + budget)
   still must all clear.

## 1. Over-block (false KEEP removed — could it now reap something it shouldn't?)

The only sessions newly reachable for reaping are: idle-at-a-ready-prompt,
transcript-not-growing, under CPU pressure, whose ONLY surviving keep-reason was
an existing-but-CPU-flat child. That is precisely the wedged/idle-child case we
want reclaimed. A genuinely-working session is still protected three ways:
(a) if any descendant burns CPU the delta is positive ⇒ veto stands;
(b) `descendantCpuSeconds` includes the main process, so a CPU-burning
extended-think keeps it; (c) the positive-idle gate requires an affirmative
ready-prompt with no working-footer, so a mid-turn session (footer present)
returns `no-positive-idle` and is kept regardless. A wedged-but-not-idle session
(no ready prompt) is likewise kept by positive-idle — the reaper stays
conservative there (that case is the StaleSessionBackstop's operator-ask job, not
the reaper's).

## 2. Under-block (did we loosen a real protection?)

No protection is loosened for any non-reaper caller. The shared `ReapGuard` used
by `terminateSession` (the authority that vetoes OTHER killers) is unchanged, so
external kills still honor the full existence-veto. Only the deliberate,
pressure-gated, hysteresis-bounded reaper relaxes it, and only under load.

## 3. Blast radius / rollout

Dark by default (`cpuAwareActiveProcessKeep: false`). Dev agents get it via the
`developmentAgent` gate at the server wiring site (`?? !!config.developmentAgent`)
— an explicit config value always wins. On the fleet (no `developmentAgent`) the
flag is false ⇒ the new code path is never entered ⇒ identical behavior to
today. Echo (developmentAgent) dogfoods it live on a genuinely loaded box.

## 4. Migration parity

- **Config:** no `migrateConfig` entry is added *by design*. The default is
  resolved at the server wiring site via the `developmentAgent` gate, NOT written
  into `config.json`. Writing an explicit `false` into existing configs would
  *wrongly override* the gate on dev agents (explicit beats `??`). Existing
  agents therefore receive the correct behavior (dev on, fleet off) through the
  code path with no config write. `cpuActiveMinRatePerSec` falls back to the
  `DEFAULT_SESSION_REAPER_CONFIG` value for agents without the field.
- **CLAUDE.md:** the new-agent template (`generateClaudeMd`) gains an awareness
  line. No `migrateClaudeMd` entry — the feature is dark on the fleet, so existing
  agents don't need the awareness until a future fleet-promotion change (which
  will add it), per the maturity-honesty principle (don't document a dark feature
  to existing agents as if it's live).

## 5. Observability

Each veto-relaxation emits a `cpu-keep-tightened` row to `logs/reaper-audit.jsonl`
(tier, verdict, keptBy, the active threshold). A kill-path behavior change leaves
a durable trail — never silent.

## 6. What it does NOT do

- Does not change `hasActiveProcesses` itself (so `UpdateGate`, `SessionManager`
  idle-detection, and `SessionRecovery` are untouched).
- Does not kill on CPU-flatness alone (always falls through to the idle proof).
- Does not run off-pressure or when CPU is unmeasurable.
