# Upgrade Guide — vNEXT

<!-- bump: patch -->

## Summary of New Capabilities

The better-sqlite3 native-bindings self-heal gains a source-build fallback and a loop-breaker. You'll notice the difference if an install on a fresh Node major version (where no prebuild exists yet) or a machine with a corrupted prebuild now recovers automatically instead of crash-looping. There's no new agent-facing surface — this is all under-the-hood install-time machinery.

Also in this release: the Lifeline Supervisor probe no longer false-positives in system reviews. The server was reporting "Server down, restart attempts: 0" on every review even when healthy. That phantom failure is gone, and reviews now reflect real health.

| Capability | How to Use |
|-----------|-----------|
| better-sqlite3 source-build fallback + loop-breaker | automatic |
| Honest lifeline monitoring from the server | automatic |

## What to Tell Your User

Nothing unless they ask. If they've seen their agent crash-loop on startup with better-sqlite3 errors in the logs, tell them:

> I patched the startup self-heal. If the native binding is missing or broken, I'll now rebuild it from source instead of redownloading the same broken prebuild over and over. And if both paths fail, I'll stop retrying and degrade to a slower backing store so your agent stays up — you'll see a log line, not a crash loop.

And if they've noticed the system review stuck on "critical" with a lifeline-supervisor-down warning:

> That alert was a false alarm — the server was asking about supervisor state that lives in a different process. I've quieted the false signal; system reviews now reflect real health.

## What Changed

**better-sqlite3 self-heal (`scripts/fix-better-sqlite3.cjs`)** — now has a source-build fallback and a loop-breaker, closing the "keep redownloading the same broken prebuild forever" failure mode observed on Dawn's machine on 2026-04-20.

Previously, the fix script had exactly one strategy: download the matching prebuild from the WiseLibs/better-sqlite3 GitHub release. If the prebuild didn't exist for the current (better-sqlite3 version, Node MODULE_VERSION, platform, arch) tuple, or if the downloaded tarball's binary still failed to load, the script exited 1. Under launchd KeepAlive, a crashing server would respawn, re-enter the fix script, redownload the same broken tarball, and fail again.

Now:
1. Prebuild attempt (unchanged) — curl the prebuild, extract, test.
2. Source-build fallback — if the prebuild is missing OR fails to load after install, run `npm rebuild better-sqlite3 --build-from-source`.
3. Attempt-state tracking — each attempt writes to `<better-sqlite3>/.instar-fix-state.json`, keyed by (version, MODULE_VERSION, platform, arch). A Node upgrade naturally invalidates stale state.
4. Loop-breaker — if state shows the current tuple has already exhausted both prebuild and source-build, the script exits 1 immediately. Caller (`ensureSqliteBindings` in `src/commands/server.ts`) then degrades to JSONL-only mode instead of crash-looping.

**Lifeline Supervisor probe (`src/monitoring/probes/LifelineProbe.ts` + `src/commands/server.ts`)** — the supervisor-status dep in `LifelineProbeDeps` is now optional. When omitted, the supervisor probe is not produced by the factory. The server's probe-registration site drops the hard-coded stub that always returned `{running: false, healthy: false}` and was the source of a 100% false-positive on every system review. The process probe (lock-file/PID check) and queue-health probe remain — those are the signals the server can honestly produce.

## Why This Matters

Both fixes follow the same pattern: an automated path needs a deterministic terminal condition AND an honest signal. Without the loop-breaker, launchd respawn cycles drown the machine in repeated downloads of a known-broken binary. Without making the supervisor probe optional, every system review was critical for a phantom reason, masking real degradations.

## Test Plan

- [x] `tests/unit/fix-better-sqlite3-state.test.ts` — 8 scenarios covering tuple-key derivation, state read/write roundtrip, attempt append, tuple-change state reset, best-effort write-failure tolerance.
- [x] CLI smoke-test: `node scripts/fix-better-sqlite3.cjs` on a machine with a valid binary reports "Native binary is working correctly" and exits 0.
- [ ] Manual verification on a machine with a deliberately-broken prebuild would exercise the full fallback chain.
- [x] Typecheck (`npm run build`) passes with the probe factory change.
- [x] Single-caller grep (`createLifelineProbes` / `getSupervisorStatus` in `src/` and `tests/`) confirms no other site needs updating.

## Evidence

Lifeline supervisor false-positive — reproduction: on any running instar server (v0.28.65 and earlier), hitting the system-reviews endpoint returns a results array containing the supervisor probe with passed=false and error "Server down, restart attempts: 0" — independent of the server's actual health. Multiple agents reported this in the field (clusters `cluster-lifeline-supervisor-probe-reports-server-down-while-server-i` and `cluster-lifeline-supervisor-probe-false-positive-marks-healthy-serve`), each showing the health endpoint returning ok while the probe reported down. Verified fix by code inspection — the probe factory is called from a single site, which now omits the supervisor-status dep. With the stub removed, the probe is not emitted from the server, so the false-positive cannot recur from this context.

## Side Effects

See:
- `upgrades/side-effects/native-module-source-build-fallback.md`
- `upgrades/side-effects/lifeline-supervisor-probe-optional.md`
