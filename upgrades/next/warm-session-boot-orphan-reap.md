<!-- bump: patch -->

## What Changed

Boot-time reap of orphaned warm-session A2A workers. The `WarmSessionPool`
(shipped in #752) is **in-memory**, so on a server restart it starts empty while
`msg-warm-*` tmux sessions spawned by the *previous* instance may still be alive.
Those are orphaned: the fresh pool holds no record of them, so the periodic TTL
reap tick never sees them — they linger until the general idle-session reaper
eventually catches them, and under a load-induced restart churn they accumulate.

On boot (when warm sessions are enabled), the server now scans the running
sessions for the warm-worker name marker and kills any it finds. With a fresh,
empty pool, every live `msg-warm-*` session is definitionally an orphan from a
prior instance, so this is safe. The selection logic is a pure, framework-agnostic
static method (`WarmSessionPool.selectBootOrphanNames`) keyed on the shared
`WarmSessionPool.NAME_MARKER` — the same constant the spawn path uses, so the
spawn name and the orphan scan can't drift. Reaping is lossless: a peer's next
message on that thread resumes via the `--resume` path (#746; the resume-map is
durable).

## Evidence

Found while running A6 (the live Echo↔Dawn warm-session verification): the probe's
warm session outlived its TTL because the server had restarted under fleet load,
leaving the new in-memory pool with no record to reap it. Logged as framework-issue
`f7a8ce9d` (Threadline in-memory state does not survive a restart).

- *Before:* an orphaned `echo-msg-warm-…` tmux session persisted past its 600s TTL
  with the warm reap tick unable to see it (empty pool on the new instance).
- *After:* unit tests on `selectBootOrphanNames` confirm it selects warm-named
  sessions (agent-prefixed `echo-msg-warm-…` and bare `msg-warm-…`) and ignores
  non-warm sessions (topic sessions, cold `msg-spawn-…`, missing names), with a
  no-drift test pinning the spawn marker to the scan marker. tsc clean; the warm
  unit (15) + integration (5) + e2e (1) suites stay green (no regression);
  esm/no-empty-catch/no-silent-fallbacks/framework-agnosticism gates green.

## What to Tell Your User

When my server restarts, the short-lived agent-to-agent "warm" reply sessions from
before the restart are now cleaned up immediately instead of lingering until the
idle reaper catches them — a small tidiness/resource fix. Nothing to turn on, and
no conversation is lost (a follow-up just resumes the thread).

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Boot-time warm-orphan reap | Automatic on server start when warm-session A2A is enabled. Orphaned warm reply sessions left over from a prior instance are reaped at boot. |
| selectBootOrphanNames helper | Pure, unit-tested helper that, given the running-session list, returns the warm-worker tmux names to reap. |
