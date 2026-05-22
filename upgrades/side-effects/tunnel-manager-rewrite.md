# Side-effects review — TunnelManager rewrite (PR 2 of tunnel-failure-resilience chain)

**Scope (this PR — second in the chain):** Rewrite `TunnelManager.ts`
to drive the foundation modules (provider abstraction + state machine
+ notifier) landed in PR 1, and retire the duplicate retry machinery
in `server.ts`. Spec
`specs/dev-infrastructure/tunnel-failure-resilience.md` is converged
+ approved on main. Public API surface of `TunnelManager` is preserved
exactly; behavior under the happy path is unchanged.

**Files touched:**
- `src/tunnel/TunnelManager.ts` — REWRITTEN. The legacy class (which
  spawned cloudflared directly and owned its own reconnect loop) is
  replaced with a manager that builds a Tier-1 provider pool, drives
  it through `TunnelLifecycle`, plumbs transitions to the
  `TunnelNotifier` (when a sink is injected), and persists the
  lifecycle snapshot to `tunnel.json`. Public surface (`start()`,
  `stop()`, `forceStop()`, `enableAutoReconnect()`,
  `disableAutoReconnect()`, `getExternalUrl()`, `url` / `isRunning` /
  `state`) preserved exactly.
- `src/commands/server.ts` — Removed the startup-retry ladder
  (5-attempt loop with 15-120s exponential backoff), the
  background-retry scheduler (the 5/10/20-minute `scheduleRetry`
  callbacks), and the single Lifeline failure message
  ("Tunnel failed after all retries..."). Replaced with a single
  `await tunnel.start()` call; failure is non-fatal and the manager
  handles retry internally.
- `tests/unit/tunnel-manager-rewrite.test.ts` — NEW. 16 tests covering
  the happy path, reachability probe, provider-failure → next, stop
  semantics, notifier wiring, and persistence restoration.

**Under-block**: None. The new manager preserves the legacy public
API surface; all existing callers (`SleepWake` handler, the
construction site in `server.ts`) keep working unchanged.

**Over-block**: Minor. The old `server.ts` background-retry scheduler
fired retries at 5/10/20-minute intervals after the inner ladder gave
up. The new manager's bounded startup-reconnect ladder is 10 attempts
with exponential backoff (max 5-min delay between rounds), then the
post-exhausted self-heal placeholder fires every 15 min indefinitely.
Net effect: under sustained Cloudflare outage, the recovery cadence is
similar but more predictable. **`start()` itself rejects after the
FIRST round of provider attempts fails** (matching the legacy
semantics) — the backoff retry runs entirely in the background so
`start()` does not block the caller. This was the fix to a
`tests/e2e/tunnel-private-view.test.ts` 60-second hook-timeout
regression observed on the initial PR 2 CI run; the original draft
had kept retrying synchronously inside `start()`.
server.ts is also defensive: failure on initial `start()` is
non-fatal and execution continues; the manager keeps trying in the
background.

**Level-of-abstraction fit**: The manager is the sole owner of
detect → attempt → fall-back → notify per the spec's single-owner
mandate. Provider implementations remain narrowly responsible for
spawn + URL emission + teardown. The lifecycle module remains
provider-agnostic and notification-agnostic; the notifier remains
channel-agnostic. No layering violation introduced.

**Signal vs authority**: Compliant. The manager classifies provider
failures into `ProviderFailureReason` and routes them to the
lifecycle's authoritative state machine (CAS-guarded). The notifier
remains a read-only consumer of transition events. No new authority
introduced at the wrong layer.

**Interactions**:
- `SleepWake` handler in `server.ts` (lines 5818-5848) is unchanged —
  it calls `disableAutoReconnect()` / `forceStop()` /
  `enableAutoReconnect()` / `start()` exactly as before. The new
  manager's `forceStop()` is a thin wrapper over `stop()`, and the
  providers' own `stop()` implementations escalate to SIGKILL — the
  same forceful-teardown semantics the legacy `forceStop(5000)`
  provided.
- The `Promise.race([restart, 15s-timeout])` in SleepWake interacts
  cleanly with the new manager's internal retry: if `start()` doesn't
  resolve in 15s, the timeout fires, the catch re-enables
  auto-reconnect (already always-on in the new design), and the
  manager continues retrying internally.
- The post-exhausted retry timer is registered with the manager's
  own field tracking; `stop()` clears it. No timer leak across
  episodes.

**External surfaces**: None. No new API endpoint, no new CLI command,
no new public config field, no change to the TunnelManager
constructor's required signature (the optional `injections` parameter
is purely additive for testability).

**Migration parity**:
- No agent-installed file change (the manager is server-side code).
- `tunnel.json` format change: the file now carries lifecycle snapshot
  fields. The constructor is tolerant of an old-format file (corrupted
  parse → starts fresh) and of an absent file (no-op). No migration
  helper needed.

**Rollback cost**: Trivial. Revert two files (`TunnelManager.ts` +
`server.ts`) + the test file. The new modules from PR 1 stay
in tree but become unused; subsequent revert of PR 1 (also a clean
file-delete) would restore the legacy state entirely.

**Tests**:
- 16/16 new tests in `tests/unit/tunnel-manager-rewrite.test.ts`.
- 32/32 tests in `tests/unit/tunnel-lifecycle.test.ts` (foundation,
  unchanged).
- 12/12 tests in `tests/unit/tunnel-notifier.test.ts` (foundation,
  unchanged).
- 10/10 tests in `tests/unit/tunnel-providers.test.ts` (foundation,
  unchanged).
- `tsc --noEmit` clean. `npm run lint` clean.

**Decision-point inventory**:
1. Public API surface preserved exactly (vs. introducing a new class
   name like `TunnelManagerV2` and migrating callers) — preserves the
   "single-owner mandate" naturally and avoids a dual-implementation
   transition window where both the legacy and new classes live in
   tree.
2. Reachability probe is owned by the manager (not by providers) per
   the spec's separation of concerns. Providers cannot self-certify
   reachability without violating the authority discipline.
3. Post-exhausted retry placeholder lives in the manager (vs. living
   in `server.ts` as a separate scheduler). One owner, one retry
   engine, even for the long-tail recovery path. The placeholder will
   be replaced by the spec's N-consecutive-success stability-gated
   probe in a later PR; the placeholder's API is internal so the
   replacement is non-breaking.
4. `tunnel.json` schema extended additively (`version: 1` field
   added, plus new fields alongside the legacy `lastUrl`). An older
   file produces a graceful "start fresh"; a new file is unreadable
   to a downgraded binary but the downgraded binary will simply
   overwrite it with the legacy format — no permanent corruption.
