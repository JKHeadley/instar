# Side-Effects Review — Warm-Session Boot-Orphan Reap

**Version / slug:** `warm-session-boot-orphan-reap`
**Date:** `2026-06-04`
**Author:** `Echo (instar dev agent)`
**Second-pass reviewer:** `not required (Tier 1 — additive, gated, single-concern)`

## Summary of the change

The `WarmSessionPool` is in-memory, so on a server restart it starts empty while
`msg-warm-*` tmux sessions from the prior instance may still be alive — orphaned
(no pool record → the TTL reap tick never sees them; backstopped only by the
idle-session reaper). On boot (when warm is enabled), the server now scans
`sessionManager.listRunningSessions()` for the warm-worker name marker and kills
any matches via the existing `killWarmSessionByName`. Selection is a pure static
method `WarmSessionPool.selectBootOrphanNames(sessions)` keyed on the shared
`WarmSessionPool.NAME_MARKER` (also used by the spawn path → no name drift). Files:
`src/threadline/WarmSessionPool.ts` (static method + marker), `src/commands/server.ts`
(boot-reap call + spawn-name uses the marker), `tests/unit/threadline/WarmSessionPool.test.ts`.

## Decision-point inventory

- `WarmSessionPool.NAME_MARKER` / `selectBootOrphanNames` (`WarmSessionPool.ts`) — **new (pure)** — single source of truth for the warm name + the orphan scan; no I/O.
- Boot-reap block (`server.ts`, inside `if (warmEnabled)`) — **new (gated)** — runs only when warm is enabled; calls the existing `killWarmSessionByName`; wrapped in try/catch that LOGS (non-fatal).
- Spawn name (`server.ts`) — **modify (no behavior change)** — `msg-warm-${Date.now()}` → `${NAME_MARKER}${Date.now()}` (same string).

## 1. Over-block

Could it kill a session it shouldn't? It only matches names containing `msg-warm-`,
and only at boot when the pool is empty (so there is no in-flight warm session it
could race). `selectBootOrphanNames` is unit-tested to IGNORE non-warm sessions
(topic sessions, cold `msg-spawn-…`, missing names). A cold one-shot reply is
`msg-spawn-…` (distinct prefix) → not matched. So no legitimate session is reaped.

## 2. Under-block

Misses nothing it should catch within a single boot: every live warm-named session
at boot is an orphan. It does NOT address warm sessions orphaned *during* a running
instance — those are correctly handled by the TTL reap tick (the pool tracks them).
The cross-restart thread-history readability gap (framework-issue `f5719295`) is a
separate concern, untouched here.

## 3. Level-of-abstraction fit

The "which names are orphans" decision lives on `WarmSessionPool` (which owns the
warm-session concept + the name marker); the server owns the boot lifecycle + the
kill primitive and just wires them. Pure logic is testable in isolation; the server
does no string-matching of its own.

## 4. Signal vs authority compliance

Not a gate/authority change. No approval surface. Reaping is housekeeping; it logs
each kill.

## 5. Interactions

- Lossless: a peer's next message on a reaped thread resumes via `--resume` (#746;
  the resume-map is durable) — continuity is unaffected.
- Complements the existing TTL reap tick (in-lifetime) + the idle-session reaper
  (backstop). This closes the at-boot gap for the load-restart-churn case echo hits.
- tsc clean; warm unit (15, +3 new) + integration (5) + e2e (1) green; esm /
  no-empty-catch / no-silent-fallbacks / framework-agnosticism gates green.

## 6. External surfaces

No new HTTP route, no config surface, no template/CLAUDE.md change. Pure internal
boot-lifecycle behavior; nothing to migrate (the reap is derived at boot, not a
persisted field).

## 7. Rollback cost

Low — revert the three files. No persisted-format change. The marker rename in the
spawn path is the same string, so even a partial revert is safe.

## Framework generality

Framework-agnostic: the orphan scan matches on the warm-session NAME pattern
(`msg-warm-`), never a framework-specific process name. Warm workers are named the
same regardless of framework (claude-code / codex-cli / gemini-cli), so the reap
covers every framework's orphaned warm sessions identically. The change does not
touch the launch/inject abstraction surface (frameworkSessionLaunch /
frameworkInjectionProcesses / MessageDelivery).

## Conclusion

Low-risk, additive, gated boot-time housekeeping that closes the warm-orphan
accumulation gap under restart churn. The selection decision is pure + unit-tested
on both sides; reaping is lossless via the durable resume path; framework-agnostic.

## Second-pass review (if required)

Not required — Tier 1 (additive, gated, single-concern, pure-logic core).
