# Side-effects review — tunnel failure resilience (foundation checkpoint)

**Scope (this commit — checkpoint 1 of N):** Land the foundation layer
that the rest of the feature builds on. This checkpoint introduces
NEW modules in isolation; it does NOT yet rewire `TunnelManager.ts` or
`server.ts`, so existing tunnel behavior is unchanged. Subsequent
commits on this branch layer on (1) `TunnelManager` rewrite to drive
the new lifecycle, (2) localtunnel provider + consent flow, (3)
`TelegramAdapter.sendToOwnerDM` + inline-button consent UX, (4)
`authToken`/PIN rotation lifecycle + boot recovery, (5) self-heal probe,
(6) `/tunnel` route, (7) `ConfigDefaults` migration + CLAUDE.md template
update, (8) Tier-2/3 tests. The PR opens once the full feature lands.

**Files touched in this checkpoint:**
- `specs/dev-infrastructure/tunnel-failure-resilience.md` — fix
  `eli16-overview` frontmatter pointer to the actual `.eli16.md` file
  (was pointing at a section anchor in the convergence report, which
  the gate cannot resolve).
- `specs/dev-infrastructure/tunnel-failure-resilience.eli16.md` —
  recreated (the original was lost in a worktree rebase).
- `src/tunnel/TunnelProvider.ts` — NEW. Provider abstraction interface
  + `ProviderName`/`ProviderTier`/`ProviderFailureReason` enums.
- `src/tunnel/CloudflareQuickProvider.ts` — NEW. Tier-1 quick-tunnel
  provider extracted from the original `TunnelManager.startQuickTunnel`.
- `src/tunnel/CloudflareNamedProvider.ts` — NEW. Tier-1 named-tunnel
  provider (token-auth + config-file-auth) extracted from the
  original `TunnelManager.startNamedTunnel` + `startConfigFileTunnel`.
- `src/tunnel/TunnelLifecycle.ts` — NEW. Single-writer CAS-guarded
  state machine for the tunnel lifecycle (idle → starting → active |
  retrying → awaiting-consent → relay-active | self-healing |
  exhausted). Episode model, cross-episode consent cooldown,
  rotation-pending flag, monotonic transition epoch.
- `src/tunnel/TunnelNotifier.ts` — NEW. Two-channel routing (group
  status text only; owner-DM credentials only) with class-based
  throttling (action-required never throttled; state-change keyed per
  (state, channel) within window; noise emits once per episode).
- `tests/unit/tunnel-providers.test.ts` — NEW. 10 tests covering
  provider interface + `isAvailable` semantics + start-rejection paths.
- `tests/unit/tunnel-lifecycle.test.ts` — NEW. 32 tests covering CAS
  guard, transition validity, episode lifecycle, consent cooldown
  exponential backoff, rotation flag, classifyFailure, generators.
- `tests/unit/tunnel-notifier.test.ts` — NEW. 12 tests covering
  channel separation (no credentials in group), epoch dedup, class
  throttling, flap-collapse, sink-error swallowing.

**Under-block**: None introduced by this checkpoint. The new modules
are not yet wired into the live tunnel path — existing
`TunnelManager.ts` is untouched and behaves identically. The wire-up
happens in the next commit on this branch.

**Over-block**: None. The new modules are additive; no existing
control-flow is changed yet.

**Level-of-abstraction fit**:
- `TunnelProvider` is a pure interface; concrete providers are thin
  wrappers around `cloudflared`.
- `TunnelLifecycle` is provider-agnostic and notification-agnostic; it
  owns ONLY state.
- `TunnelNotifier` is lifecycle-aware (consumes transition events) but
  channel-agnostic (delegates to a `NotifierSink` interface).
- Separation lets subsequent commits swap implementations (e.g., add
  the localtunnel provider) without touching the lifecycle or notifier.

**Signal vs authority**: Compliant. Providers raise failure errors
(SIGNAL via Error.message classification); the lifecycle classifies
into `ProviderFailureReason` (AUTHORITY); the notifier consumes the
classified signal (READ-ONLY consumer). No new authority is introduced
at the wrong layer.

**Interactions**:
- New modules import only from each other and node:crypto / node:events
  / cloudflared. No interaction with existing TelegramAdapter,
  PostUpdateMigrator, or server.ts in this checkpoint.
- Notifier's `NotifierSink` interface is satisfied by the existing
  `TelegramAdapter.sendToTopic` for the group channel; the owner-DM
  send method (`sendOwnerDM`) does not exist yet and will be added in
  a subsequent commit. Until then, tests use mock sinks.

**External surfaces**: None. No new API endpoint, no new CLI command,
no new config field user-facing. The new types are exported from
`src/tunnel/*` but no caller imports them in this checkpoint.

**Migration parity**: N/A for this checkpoint (no agent-installed
file changes). The migration story (ConfigDefaults entries, CLAUDE.md
template + migrator updates) lands in a later commit on this branch.

**Rollback cost**: Trivial. Revert these eight new files + the spec
frontmatter pointer fix; the eli16.md companion goes with them.
Nothing else changes.

**Tests**:
- 10/10 tests in `tests/unit/tunnel-providers.test.ts` pass.
- 32/32 tests in `tests/unit/tunnel-lifecycle.test.ts` pass.
- 12/12 tests in `tests/unit/tunnel-notifier.test.ts` pass.
- `tsc --noEmit` clean. `npm run lint` clean.
- No existing tests were modified; no regressions.

**Decision-point inventory**:
1. Provider interface is named-provider-aware (`isAvailable()` returns
   false when neither token nor configFile is configured) so the
   manager naturally skips the named path on quick-only installs.
2. Lifecycle uses CAS (`transition(expectedFrom, to)`) instead of
   message-passing — Node single-threaded model makes the synchronous
   compare-and-set sufficient; the alternative (a queue) was unnecessary
   complexity.
3. `noiseEmittedThisEpisode` is a per-episode boolean; the flap-
   collapse message lands at most once per episode regardless of how
   many flap cycles happen. Trades fidelity (which cycle triggered it)
   for guaranteed non-flooding.
4. Throttle key for state-change is `<state>::<channel>` — the group
   pointer and owner-DM credential delivery for the same state-change
   must both be allowed; channel-blind keying would suppress the DM
   after the group pointer fired, which is exactly the bug the
   unit tests caught during this checkpoint's build.
5. `TunnelLifecycle.restoreFrom` does NOT resume the live state.
   Every boot starts at `idle` and re-enters `starting` from scratch.
   The persisted `rotationPending` flag is the only piece that
   triggers a boot-time action (the rotation in checkpoint 4).
