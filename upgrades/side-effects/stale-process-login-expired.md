# Side-Effects Review — one session's expired-login screen no longer benches a working login

**Version / slug:** `stale-process-login-expired`
**Date:** `2026-11-20`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (required: pool-status decision, session restart, NeverSilent action gating)`

## Summary of the change

Tier 2, spec `docs/specs/stale-process-login-expired.md` (converged in 6 rounds with codex-cli:gpt-6.2-astra every round, plus 3 targeted safety-verifier passes; approved by the agent). ⚠ Proportion: 6 rounds and a 38 KB spec for roughly 600 lines of code. Each round found real design issues, so the rounds were earned, but the spec's length outgrew the conformance gate's input.

On 2026-11-20 one session's `Login expired` screen benched the Studio's `sagemind-adriana` account for hours and drove a sign-in loop, while every usage read and a fresh `claude -p` with that login worked. Now:
- **`src/core/freshLoginProbe.ts` (new):** a contained real call on the stored login. No tools, MCP servers, hooks, settings sources or transcript, and credential and provider env stripped. The verdict comes from the CLI's structured result, with `apiKeySource: none` and `served_by_anthropic: true` required for `ok`.
- **`src/core/FreshProbeScheduler.ts` (new):** when a probe may run and which result is current. At most 6 spawns per account per 12 h, persisted and reserved inside the host spawn cap. Validate-then-cache with `lastContraryAt`; a conclusive verdict lasts per credential (12 h max); backoff plus a 24 h breaker for inconclusive results.
- **`src/core/freshLoginProbeWiring.ts` (new):** the production builder: routed folder, the 15-minute token-expiry gate, the spawn cap, the feature-metrics row (`QuotaPoller.freshLoginProbe`), and an atomic state file.
- **`src/core/QuotaPoller.ts`:**
  - `observeCliLoginExpired` takes `{ awaitProbeMs, markWhilePending }` and returns `probe` / `staleProcess`.
  - A current `ok` skips the mark, or releases a pane-cause hold.
  - The latest-mark cause is recorded, so a stronger bench is never released.
  - Polls never wait on a probe.
  - `pollAll` has an in-flight guard.
  - New accessors: `setFreshProbe`, `applyFreshVerdict`, `routedConfigHome`, `lastCredentialFingerprint`, `noteFreshProbeContrary`.
- **`src/core/InteractiveLoginExpiredRecovery.ts`:** the recovery waits 20 s for the probe. A stale process is refreshed in place on its own account (`SessionRefresh`, `callerClass: 'recovery'`), with identity, screen and ownership rechecked at dispatch and a cap of 3 refreshes per account per 10 min. A pending probe is not run the swap. A failed refresh is `refresh-failed`, not contrary evidence. A replacement process failing again counts as contrary evidence and that session takes the swap. New `inPlaceRefreshPossible`.
- **NeverSilent (`NeverSilentPolicy.ts`, `NeverSilentWatcher.ts`, `NeverSilentStore.ts`, `neverSilentWiring.ts`):** `wait` (with a plain "restarting on its own sign-in" notice) instead of a swap or fallback while a probe is pending, or while an in-place refresh is possible after an `ok`. Hard cap of 3 minutes per persisted incident.
- **`src/commands/server.ts`:** builds and attaches the scheduler behind the live switch `subscriptionPool.freshLoginProbe.enabled` (code default on). Waits per caller: rerouted sink 20 s, recovery 20 s, NeverSilent 0 s (it may start or join a probe, still bounded by the scheduler, and never marks while one is pending). Real recovery hooks, with ownership read from the stand-down registry.
- **Awareness:** `INTERACTIVE_LOGIN_EXPIRED_BULLET` rewritten. The old text is kept as `_V1`, and `PostUpdateMigrator` replaces it in place before the key-health block anchors on it.

## Decision-point inventory

- `QuotaPoller.observeCliLoginExpired`: mark or not. **Modify:** a conclusive, current probe `ok` (the stored login answered a real call) now outranks one process's screen. Every other outcome keeps today's mark.
- `QuotaPoller` hold release: **add**, only for a pane-cause latest mark, on a validated `ok`.
- `InteractiveLoginExpiredRecovery`: refresh in place vs swap vs nothing. **Add** the in-place branch; the swap path is unchanged.
- `decideNeverSilentAction`: **add** a bounded `wait` branch (at most 3 minutes per incident).

## 1. Over-block

No issue identified. The change only relaxes a bench, and only on positive proof. It never adds a block. NeverSilent's new `wait` holds an automatic move for at most 3 minutes per incident, then falls through to today's handling.

## 2. Under-block

- A truly dead login whose fresh process somehow still answers would not be benched until a later refusal. The containment (no env credentials, no settings sources, `apiKeySource: none`, `served_by_anthropic: true`) means only the routed folder's stored login can authenticate the probe. A `refused` from any later read, or a replacement process failing after an in-place refresh, is contrary evidence that restores the bench.
- With the probe unavailable (expiry inside the margin, breaker, switch off), the old single-screen rule still benches. This is the declared floor (CMT-1008), kept on purpose.
- The probe's 15-minute expiry margin is an estimate; the CLI's refresh window is not published. A probe inside an unknown wider window is no different from placing one more session on the login.

## 3. Level-of-abstraction fit

Right layer. The quota poller stays the single authority over pool status and consumes the probe as evidence. The recovery owns session actions, NeverSilent owns notices and moves, and each only gains inputs.

## 4. Signal vs authority compliance

- [x] The probe is a signal: a stronger, direct check of the same credential. The poller stays the authority and relaxes only on a conclusive, current, validated `ok`. Every brittle or failed probe path falls back to today's behaviour. No new blocking authority is added.

## 4b. Judgment-point check

Decision points are classified in the spec's table. The judgment-candidate points have a deterministic floor (today's behaviour) and a deterministic arbiter (the probe's structured verdict). Fixed limits are bounds on physical work, with stated bases; the gate's contest of their exact values is recorded as accepted risk.

## 5. Interactions

- **Reissue sweep:** once an account is restored to `active`, `completeIfAlreadySignedIn` closes the stale pending login (it still requires its own live identity read).
- **Swap funnel / `loginExpiredSwap.enabled`:** the stale branch runs before the swap switch, because an in-place refresh is not a swap.
- **SessionRefresh's own limit** (5 per 10 min) still applies; the per-account bound of 3 is stricter.
- **NeverSilent vs recovery:** NeverSilent never marks while a probe is pending; the recovery marks at its deadline but is not run the swap. The incident clock is persisted, so a restart loop cannot reset it.
- **Spawn cap:** probes compete for host slots like any other `claude -p`. A shed reserves nothing.

## 6. External surfaces

- **Provider:** at most 6 one-turn fast-tier calls per account per 12 h, only while an expired screen exists (measured: 4 output tokens, ~24 k mostly-cached input tokens), recorded as `QuotaPoller.freshLoginProbe`.
- **Login folder:** one fixed probe cwd adds at most one `.claude.json` project entry. `--no-session-persistence` means no transcript is written. Accepted risk: one more writer to `.claude.json`, bounded by the rate.
- **Users:** a new plain NeverSilent notice ("restarting it on its own sign-in"). A conversation that used to be moved to another account is now restarted on its own when its login works.

## 6b. Operator-surface quality

No operator surface — not applicable (no dashboard, approval page or form touched; the one new user-facing string is a NeverSilent notice, plain-language and lint-checked).

## 7. Multi-machine posture (Cross-Machine Coherence)

machine-local-justification: physical-credential-locality

Machine-local by design: each machine probes only its own login folders. Pool status changes replicate through the existing pool-scope read (`projectAccountToMeta`). Follow-me defaults to `re-mint` (a separate login per machine), so a probe-caused refresh cannot strand another machine's copy unless a `credential-transport` mandate shared one token; that case is reduced by the expiry gate. No new notices across machines, and no URLs. The NeverSilent incident clock is stored with the machine's own incidents. No status surface changes.

## 8. Rollback cost

Set `subscriptionPool.freshLoginProbe.enabled: false` (read live): nothing is probed, no cached verdict is read, and the recovery and NeverSilent branches are unreachable. That is the old behaviour, except for the `pollAll` overlap guard, which is not behind the switch (a harmless change: overlapping poll passes now share one). Or revert and ship a patch. The leftover state is harmless: `state/fresh-login-probe.json` and the probe cwd. The CLAUDE.md bullet stays in its new wording after a revert, which slightly over-describes behaviour until the next migration; harmless.

## Conclusion

Clear to ship once the second pass concurs. Review produced the containment, the expiry gate, validate-then-cache, persisted bounds, refresh in place instead of a swap, the 3-minute NeverSilent cap, and the latest-cause guard.

## Second-pass review (if required)

**Reviewer:** independent second-pass subagent
**Independent read of the artifact: concur**

Concur with the review. The reviewer checked each relax path (all require a validated `ok` from `cached()`/`onVerdict` with the switch on, the same fingerprint and the 12 h life; release only for a pane-cause latest mark), dispatch-time ownership, identity and screen rechecks, the persisted 3-minute NeverSilent clock, reservation inside the spawn-cap callback, and switch-off behaviour. Two wording corrections were folded in above (NeverSilent may start a probe; the `pollAll` guard is not behind the switch). Noted behaviour difference, accepted: once NeverSilent's 3-minute cap expires while a probe is still pending, it swaps without marking first (the recovery path still marks), because a pending probe is not evidence the login is dead.

## Evidence pointers

- **Live (2026-11-20, Studio):** the shipped `runFreshLoginProbe` answered `ok` (claude-haiku-5-5, 4 output tokens) on the working `gearfinity3d` login and `refused`/`not-logged-in` on an empty folder.
- **Unit:**
  - `freshLoginProbe.test.ts` (13, real captured CLI fixtures)
  - `FreshProbeScheduler.test.ts` (11, including settling under every mode and restart persistence)
  - `quota-poller-stale-process.test.ts` (9)
  - `InteractiveLoginExpiredRecovery-stale-process.test.ts` (10)
  - `never-silent-stale-login.test.ts` (6)
  - `interactive-login-expired-awareness.test.ts` (+2 migration tests)
  - Existing poller, recovery and NeverSilent suites unchanged and green (102 + 71).
- **Integration:** `stale-process-login-expired.test.ts` (3, real runner plus stand-in CLI replaying real bytes; the 2026-11-20 timeline).
- **E2E:** `stale-process-login-expired-alive.test.ts` (4, server wiring plus the production builder releasing a real hold).

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. The defect was a runtime decision rule (one process's screen treated as proof about a shared stored credential), not a prompt, hook, config, skill or standards text. The new self-triggered actions (probe spawn, in-place refresh) are bounded by the existing `interactive-login-expired-swap` controller's per-session brake plus the new per-account and per-12 h ceilings, and the self-action convergence ratchet (`tests/unit/self-action-convergence.test.ts`) still passes.
