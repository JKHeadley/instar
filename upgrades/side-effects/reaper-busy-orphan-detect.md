# Side-Effects Review — SessionReaper observe-only busy-orphan detection

**Version / slug:** `reaper-busy-orphan-detect`
**Date:** `2026-06-03`
**Author:** `echo`
**Second-pass reviewer:** `not required (observe-only — never changes a keep/kill verdict; reaper-only; dark by default)`

## Summary of the change

Under CPU pressure, when a session is kept by an `active-process` veto whose
child is provably burning CPU (cpuFlat===false) yet the session itself is idle
(positive idle prompt + flat transcript) across an extended dwell, the reaper
records a `busy-orphan-suspected` audit row (and `busy-orphan-cleared` on
recovery). It is the inverse of #722's `cpuAwareActiveProcessKeep` and closes the
gap where a *busy* useless process defeats the CPU-progress proxy. Gated by
`busyOrphanDetection` (dark; dev agents on via `developmentAgent`).

## Decision-point inventory

1. **Suspect predicate** — flag iff ALL hold: `busyOrphanDetection` on, under CPU
   pressure (tier ≠ normal), `blocked.reason === 'active-process'`,
   `cpuFlat === false` (descendant CPU delta above the idle floor), transcript
   delta `static` (resolved + not grown vs the prior tick), and a positive
   idle-prompt frame. Any miss ⇒ not a suspect.
2. **Dwell** — emit `busy-orphan-suspected` exactly the tick the consecutive
   suspect streak crosses `busyOrphanConfirmTicks` (default 5). A brief
   background job that finishes within the dwell is never flagged.
3. **Clear** — when a confirmed suspect (streak ≥ threshold) stops being a suspect,
   emit `busy-orphan-cleared`. Streaks below the threshold reset silently.

## 1. Over-block (does it ever reap something it shouldn't?)

**No — it cannot reap anything.** This change is observe-only: the keep/kill
verdict path is untouched. Every code path through the detector returns the
SAME `keep('active-process')` it returned before; the only effect is an audit
row. The exact "idle session + legit busy background job" case that
`cpuAwareActiveProcessKeep` was deliberately conservative about is, here, merely
*logged* — never acted on. A false suspect costs one JSONL line, nothing more.

## 2. Under-block

Nothing is loosened. No existing protection, gate, or veto is weakened — the
shared `ReapGuard`/`ReapAuthority` path and the reaper's own stateful checks are
entirely unchanged. The detector reads the same already-captured frame and
transcript (no extra tmux/fs work) and the same `cpuFlat` signal #722 already
computes.

## 3. Blast radius / rollout

Dark by default (`busyOrphanDetection: false`). Dev agents get it via the
`developmentAgent` gate at the server wiring site (riding #722's IIFE). On the
fleet the flag is false ⇒ the detection branch is never entered and
`cpuProgressFlat` returns early exactly as before #722 ⇒ identical behavior.

## 4. Migration parity

No `migrateConfig` — same reasoning as #722: the default resolves at the server
wiring site via the `developmentAgent` gate, so writing an explicit `false` into
existing configs would wrongly override the gate on dev agents.
`busyOrphanConfirmTicks` falls back to the code default. The new-agent template
(`generateClaudeMd`) gains an awareness line; no `migrateClaudeMd` (dark feature).

## 5. Interaction with #722 (cpuAwareActiveProcessKeep)

The two are mutually exclusive on the CPU signal and complementary:
`cpuAwareActiveProcessKeep` acts when `cpuFlat === true` (relaxes the veto);
busy-orphan detection observes when `cpuFlat === false` (flags). They share the
`cpuProgressFlat` sampler, whose gate now runs when EITHER feature is on. With
both off (fleet default), the sampler returns `undefined` immediately and neither
path engages.

## 6. Audit volume

`busy-orphan-suspected` fires at most once per suspect episode (on the dwell
crossing), `busy-orphan-cleared` once on recovery — bounded, not per-tick. Lands
in `logs/reaper-audit.jsonl` like the other reaper decision rows. Silent (no
Telegram, no attention item).

## 7. What it does NOT do

- Does not reap, kill, nudge, or notify — observe-only.
- Does not run off-pressure or without the CPU dep.
- Does not change `hasActiveProcesses` or any guard.
- Does not attempt to *fix* a busy orphan (e.g. tree-kill) — that is a separate,
  deliberately-staged follow-up that would build on this measurement.
