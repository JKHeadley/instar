# Side-effects review — Fleet fix: native-module rebuild-loop + wake-socket crash-loop

## What was happening (real-hardware, 2026-05-29)

The "inspec" agent's server had restarted **1830 times** and was pinning a CPU
core. Root cause was a self-perpetuating crash loop with two independent bugs
that compounded — and the rebuild half had fired across the whole fleet:

1. **WakeSocketServer async `'error'` crashed the entire server process.** When a
   LIVE peer (a duplicate instance, or a transient rapid-respawn race) already
   holds `listener.sock`, `WakeSocketServer` emits `'error'` (EADDRINUSE)
   **asynchronously**. The server-boot consumer wired `'wake'` and
   `'failover-trigger'` listeners but **no `'error'` listener**, and its
   try/catch around `.start()` only catches *synchronous* errors. So the async
   EADDRINUSE was an unhandled EventEmitter `'error'` → the whole server process
   crashed. With the supervisor respawn, that became an unrecoverable loop.

2. **The supervisor misattributed bind failures to a native-module problem.**
   On ≥2 consecutive bind failures, `ServerSupervisor.preflightSelfHeal()`
   force-rebuilt better-sqlite3 **even when the module loaded fine** (`force =
   consecutiveBindFailures >= 2; needsRebuild = force || abiMismatch`). A bind
   failure is almost always a held/stale socket or port (EADDRINUSE), NOT a
   native ABI mismatch — so this burned the machine on futile, CPU-heavy
   node-gyp rebuilds. Fleet-wide rebuild counts: **sagemind 202, deep-signal
   144, inspec 112, ai-guy 104, codey 46.**

(inspec also had an inspec-SPECIFIC trigger: a leftover duplicate launchd job,
`ai.instar.echo-server-inspec`, ran a *second* server `--dir monroe-workspace`
that raced the lifeline-managed one for the socket. That was remediated
operationally — disabled + plist renamed `.DISABLED` — and is not a code change.)

## The fix

- **`src/commands/server.ts`** — attach `wakeSocketServer.on('error', …)`
  BEFORE `.start()`. The wake socket is an optimization (fast wake/failover from
  the listener daemon); on any error it now **degrades gracefully** (logs,
  continues without it) instead of crashing the agent. This alone breaks the
  crash loop — the server stays up even if the wake socket can't bind.

- **`src/lifeline/ServerSupervisor.ts`** — `preflightSelfHeal()` rebuilds
  better-sqlite3 **only** when a copy actually fails to load with a
  `NODE_MODULE_VERSION` ABI mismatch. The bind-failure-count force-rebuild is
  gone. A genuine native crash-loop still self-heals (a server that crashes
  before binding because the module won't load is caught by the load check); a
  held-socket bind failure now logs a clear diagnostic ("…NOT a native-module
  problem (likely a held socket/port)…") instead of rebuilding.

## Blast radius

- **Pure robustness/CPU fix — no behavior change in the healthy path.** A server
  that binds cleanly is unaffected. Genuine ABI mismatches still rebuild.
- **No new config / route / schema → no migration.** Server + supervisor code;
  existing agents pick it up on the next release. Fleet-wide benefit: stops the
  futile rebuild CPU drain + the wake-socket crash loop for every agent.
- **Degradation is safe:** without the wake socket, the agent falls back to its
  normal inbox/poll path; it just loses the fast-wake optimization.

## Tests

- `tests/unit/wake-socket-error-handling.test.ts` — wiring: the consumer
  attaches a graceful `'error'` handler before `.start()`; behavioral: a
  live-peer EADDRINUSE surfaces as a catchable `'error'` event (not an uncaught
  throw).
- `tests/unit/server-supervisor-preflight.test.ts` — bind failures + a
  fine-loading better-sqlite3 → **no** rebuild; an actual NODE_MODULE_VERSION
  load failure → rebuild still fires.
