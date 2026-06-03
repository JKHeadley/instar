# Upgrade Guide — vNEXT

<!-- bump: minor -->

## What Changed

The `SessionReaper` gains an **observe-only** busy-orphan detector behind a new
dark-by-default flag `busyOrphanDetection` — the inverse of #722's
`cpuAwareActiveProcessKeep`, closing the blind spot that fix can't reach.

**The gap.** #722 made the `active-process` keep require *positive CPU progress*
under load, so a wedged/**idle** child (≈0 CPU) no longer pins an idle session.
But CPU-progress is only a *proxy* for "useful" — a **useless process that
SPINS** (a hot-loop, a wedged job burning CPU) looks "active" and would keep the
session pinned. So #722 catches the idle orphan; it does not catch the *busy*
orphan.

**The detector.** Under CPU pressure, when a session is kept ONLY by an
`active-process` veto whose child is provably **burning CPU** (the descendant
CPU-seconds delta is above the idle floor) yet the session ITSELF looks fully
idle (a positive ready-prompt + a flat, non-growing transcript) across an
extended dwell (`busyOrphanConfirmTicks`, default 5 ≈ 10 min), the reaper records
a `busy-orphan-suspected` row in the decision audit (`logs/reaper-audit.jsonl`),
and a `busy-orphan-cleared` row when a confirmed suspect recovers.

**It NEVER changes the keep/kill decision.** This is pure observation — it makes
the "useless-but-busy child pins an idle session" case *measurable* so that safe
auto-reclaim can graduate later with real data (the instar observe-first → act
pattern). Zero false-kill risk by construction.

**Conservative by construction:**
- No-op at `normal` pressure, when the CPU dep is absent, on the first sighting
  (no transcript-growth baseline yet), and whenever the transcript is unresolved
  or growing — all resolve to "not a suspect".
- Only the `active-process` keep-reason is considered; every earlier reason
  (recent-user, commitment, recovery, …) is untouched.
- Emits the suspect row exactly ONCE — the tick the dwell crosses the threshold —
  not every tick after (no per-tick audit flood).

Ships dark fleet-wide; live on development agents via the `developmentAgent`
gate (same as #722), so it's dogfooded on a real loaded box.

## What to Tell Your User

Nothing — it is dark by default and observe-only (it never changes behavior, just
writes audit rows). If surfaced at all, surface it as Experimental observability
that makes the busy-orphan case visible.

## Summary of New Capabilities

- `monitoring.sessionReaper.busyOrphanDetection` (boolean, default false;
  `developmentAgent` agents default true) — observe-only flagging of idle
  sessions pinned by a CPU-burning child.
- `monitoring.sessionReaper.busyOrphanConfirmTicks` (number, default 5) — the
  consecutive-suspect-tick dwell before a row is emitted.
- New audit events: `busy-orphan-suspected`, `busy-orphan-cleared`.

## Evidence

- Motivated by a real review catch (the gap a busy/hot orphan defeats the
  CPU-progress proxy) and a live instance (agent servers hot-looping at ~50% CPU
  while otherwise idle).
- Tests: `tests/unit/session-reaper-busy-orphan.test.ts` — 9 tests, both sides of
  every boundary (flags only on busy-child + idle-session + dwell; never on
  CPU-flat / working-frame / flag-off / off-pressure / no-dep / pre-dwell; emits
  once; clears on recovery; verdict always unchanged) + a wiring-integrity
  assertion. The 56 existing reaper + #722 tests stay green.
