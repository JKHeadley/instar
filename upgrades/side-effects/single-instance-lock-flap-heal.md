# Side-effects review — SingleInstanceLock single-host-rename auto-heal

## What changed
`SingleInstanceLock.acquire()` gains a narrowly-gated auto-heal for the FOREIGN-host
branch. Before this change that branch refused-loud unconditionally, so when this
host's `os.hostname()` FLAPPED (observed 2026-07-08: `mac.lan` ↔
`Justins-MacBook-Pro-99.local`), a dead-holder `server-instance.lock` stamped with the
OLD name looked foreign and the server crash-looped on EVERY boot (3 wedges in one
night, recovered only by manually moving the lock + kickstart). Now, iff ALL hold —
the `autoHealStaleHostRename` flag is on, the holder pid is DEAD on this host, the
heartbeat is older than `staleHostRenameMs` (default 300000ms), AND the state dir is
`df -P` host-local — the "foreign" lock is treated as this host under a previous name
and reclaimed via the EXISTING same-host-dead reclaim path (unlink + O_EXCL rewrite).
Any unmet condition falls through to the unchanged refuse-loud.

## Side effects & blast radius
- **Touches a durable-state / boot single-instance invariant** (never "cheap"). The
  guard that prevents this being dangerous is the `df -P` host-local check: a host-local
  disk CANNOT be shared by a second physical host, so a "foreign" hostname on a
  host-local dir is provably a rename, not two hosts sharing a state dir. The
  shared-volume refuse (the 2026-06-15 hazard) is untouched when the disk is not
  confirmed host-local.
- **Fail-closed everywhere**: heartbeat absent/0 → refuse; fresh heartbeat → refuse;
  live holder → refuse; non-host-local → refuse; flag off → refuse. Only the exact
  rename signature reclaims. 7 new unit tests pin every branch (15 total, all green).
- **No new runtime cost on the hot path** — the checks run only at server BOOT during
  lock acquisition (the `df -P` subprocess is already used by the same-host-dead path).
- No API, schema, or wire-format change. No migration needed (CODE-defaulted config,
  absent from ConfigDefaults, preserving the fleet flip).

## Gating & rollback
- `monitoring.singleInstanceLock.autoHealStaleHostRename` — operator override; when
  absent, `resolveDevAgentGate(undefined, config)` resolves it LIVE on a development
  agent, DARK on the fleet (mirrors `resumeQueue.autoHealStaleHostLock`).
- Rollback: set the flag `false` (immediate, no code change) or revert the commit. With
  the flag off, behavior is byte-identical to before (refuse-loud).

## Deploy note
Activating the fix needs ONE server restart (the running server predates it). That one
restart could still hit the flap-wedge before the fix is live — the operator's self-heal
recovery covers that single crossing; after it, future flaps self-heal in code.
