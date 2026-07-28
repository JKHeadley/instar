# Side-Effects Review — QuotaAwareScheduler + continuity guarantee (P1.3)

## Scope of change

- `src/core/QuotaAwareScheduler.ts` (new) — account selection + the swap-and-resume guarantee.
- `src/core/SessionRefresh.ts` — RefreshOptions gains optional `configHome`/`accountId`; the respawner gains an optional 4th `accountSwap` arg.
- `src/core/SessionManager.ts` — `spawnInteractiveSession` options gain optional `configHome` (→ `CLAUDE_CONFIG_DIR` via the launch builder) + `subscriptionAccountId` (→ session record).
- `src/core/frameworkSessionLaunch.ts` — `InteractiveLaunchOptions.configHome` → `CLAUDE_CONFIG_DIR` env (claude-code builder).
- `src/core/types.ts` — `Session.subscriptionAccountId?`; `InstarConfig.subscriptionPool?{swapSoftThresholdPct,autoSwapOnRateLimit}`.
- `src/commands/server.ts` — wires the scheduler (refreshFn=SessionRefresh, onNoAlternate=Attention), the DARK rate-limit auto-trigger, and threads `accountSwap` through `respawnSessionForTopic` → `spawnSessionForTopic`.
- `src/server/routes.ts` + `AgentServer.ts` — `POST /subscription-pool/swap` + RouteContext plumbing.
- tests (unit + e2e) + api.md.

## The load-bearing concern: surgery on the session-restart path

This is the highest-authority change in the standard. The restart path
(SessionRefresh → respawn → spawn) is what every conversation — including the
agent's ability to reply to the operator — depends on. The safety design:

- **Additive-optional everywhere.** Every new parameter (`configHome`,
  `accountId`, `accountSwap`) is optional and defaults to today's behaviour.
  When no swap is requested — i.e. every existing restart, recovery, and spawn —
  the code path is byte-for-byte unchanged. Confirmed: the existing
  SessionRefresh suite passes after a one-line assertion update (the respawner
  now receives a trailing `undefined` 4th arg; behaviour identical).
- **The swap preserves the conversation.** `claude --resume <uuid>` is agnostic
  to `CLAUDE_CONFIG_DIR`, so resuming under a different account carries the full
  conversation (verified: the launch builder applies BOTH `--resume` and the new
  `CLAUDE_CONFIG_DIR` together). TopicResumeMap persists the uuid across the kill,
  independent of account.

## Authority / autonomy analysis

- **Auto-swap of live sessions ships DARK** behind
  `config.subscriptionPool.autoSwapOnRateLimit` (default off). Only when the
  operator enables it does a rate-limit escalation drive an automatic swap. The
  manual `POST /subscription-pool/swap` route + the selection logic are always
  available but never fire on their own.
- **Tier-2, operator-approved.** This change has real authority (restarts live
  sessions, changes spawn env). The driving spec
  (`subscription-auth-p1.3-scheduler.md`) is converged + `approved: true` by
  Justin (Telegram topic 20905, 2026-06-07).
- **Honest no-op.** When a session hits a wall with no eligible alternate, the
  scheduler does NOT restart it (nowhere to go) — it raises ONE deduped HIGH
  Attention item and leaves the existing rate-limit back-off as the floor. No
  false "swapped" claim (verified by test).

## Failure modes considered

- No alternate account → honest report + Attention, session untouched (back-off floor).
- refreshFn (SessionRefresh) reports failure → surfaced as `refresh-failed`, not a false success.
- Account over the soft threshold / rate-limited / disabled → excluded from selection.
- Single-account pool → no alternate ever → effectively a no-op (the common case today).
- Rate-limit-event session not pool-managed (no `subscriptionAccountId`) → skipped, existing back-off unchanged.

## Blast radius

Contained by the additive-optional design + the dark auto-trigger. With no
accounts enrolled and the flag off (the default), this code never executes a swap
— existing behaviour is wholly unchanged. The risk surface is the new swap path,
which is exercised only by the manual route or the explicitly-enabled auto-trigger.

## Framework generality

The launch-abstraction change (`InteractiveLaunchOptions.configHome`) is
framework-agnostic in SHAPE but intentionally Claude-specific in EFFECT for now:

- The `configHome` option is read ONLY by the claude-code builder (→
  `CLAUDE_CONFIG_DIR`). The codex-cli, gemini-cli, and pi-cli builders ignore it
  entirely — passing it is a no-op for them, so non-Claude launches are
  byte-for-byte unchanged. This is correct because per-account login isolation is
  framework-specific: codex uses its own auth/config (a different env + login
  flow), gemini likewise. There is no single cross-framework "config home" knob.
- This matches the standard's deliberate scope (Justin's decision 3: Claude-first).
  The account-swap account-selection logic (QuotaAwareScheduler) is itself
  framework-agnostic — it operates on pool accounts regardless of provider — and
  the scheduler only filters to `claude-code`/`anthropic` accounts where the swap
  mechanism is actually implemented today. Extending the swap mechanism to
  codex-cli / gemini-cli (their own per-account config) is future work, not a
  Claude-specific assumption baked into the abstraction: the option + the
  scheduler are ready for it; only the per-builder env injection is Claude-only.
- Per the constitution's "Framework-Agnostic — and Framework-Optimizing": the
  abstraction stays neutral (the option exists for all), the optimization is
  per-framework (Claude gets CLAUDE_CONFIG_DIR; others get their own when built).

## Migration / parity

`Session.subscriptionAccountId` + `InstarConfig.subscriptionPool` are additive-
optional (no migration needed). New route stays under the already-classified
`/subscription-pool` INTERNAL prefix (no CapabilityIndex change). Ships via dist.
