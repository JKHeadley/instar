# Side-Effects Review — onboarding-safe config homes for subscription pin/swap

**Version / slug:** `onboarding-safe-pinswap`
**Date:** `2026-06-09`
**Author:** `echo (Fable 5 build session)`
**Second-pass reviewer:** `self-review under the Tier-1 lite lane; every write path to .claude.json walked below`

## Summary of the change

2026-06-09 incident (topic 20905): pin/swap relaunched ~8 interactive sessions into pool-account config homes created by headless `claude auth login` — tokens present, interactive first-launch flags absent — so every one wedged on the onboarding screens. New util `ensureInteractiveReady(configHome)` idempotently seeds `hasCompletedOnboarding` / `bypassPermissionsModeAccepted` / `hasTrustDialogAccepted` in `<configHome>/.claude.json`, called at enrollment completion (EnrollmentWizard), defensively at every pinned/swapped launch (SessionManager headless-pin, interactive-reroute-pin, interactive configHome lanes; SessionRefresh before the swap respawn), and once for existing homes via a PostUpdateMigrator sweep.

## Decision-point inventory

- `src/core/ensureInteractiveReady.ts` — NEW — the only writer. Sets exactly the three flags; preserves every other key; refuses unparseable/non-object files (never clobbers a file that may hold salvageable credentials); atomic tmp+rename write; never throws (fail-safe contract); `requireExistingHome` gate for the migration sweep.
- `SessionManager.ensurePinnedHomeInteractiveReady` — NEW private helper — log-and-continue on failure; called in the headless pin lane, the interactive-reroute pin lane, and `spawnInteractiveSession` when `options.configHome` is set (claude-code only).
- `SessionRefresh.refreshSession` — seeds the target home whenever `accountSwap.configHome` is present (fresh and resume swaps both relaunch interactively), BEFORE the respawner fires.
- `EnrollmentWizard.complete()` — seeds for claude-code logins with a configHome; injectable `ensureReady` seam (default = real util). A seeding failure never blocks completion.
- `PostUpdateMigrator.migrateSubscriptionPoolInteractiveReady` — one-time sweep over `SubscriptionPool.list()` claude-code accounts; `requireExistingHome:true` so a stale registry entry never litters $HOME; per-home failures reported in `result.errors`, never abort the sweep.
- `ProactiveSwapMonitor` — comment-only TODO for active-session-only gating (secondary incident finding, deferred to a follow-up).

## Could this corrupt credentials? (the load-bearing question)

The util never touches `oauthAccount` or any token field — it sets three booleans on the parsed object and writes the rest back. Unparseable or non-object files are REFUSED, not rewritten (bytes preserved exactly — pinned by unit tests). Writes are atomic (tmp+rename) so a crash mid-write cannot truncate `.claude.json`. The Monroe homes (`~/.claude`, `~/.claude-monroe`) are not in any subscription pool registry and no new code path enumerates $HOME — only registry/launch-provided configHome values are ever touched.

## Could the seeding itself break a launch?

No — fail-safe by contract: every failure lane returns `{patched:false, reason}`; callers log and proceed. Worst case is byte-identical to the pre-fix behavior (the onboarding wedge), never a dead spawn/refresh path. Pinned-spawn behavior when the resolver returns null, and refreshes without an account swap, are unchanged (covered by existing + new tests).

## Framework generality

Seeding is gated to claude-code everywhere: the SessionManager lanes only run for claude-code launches, EnrollmentWizard checks `login.framework === 'claude-code'`, and the migrator filters `framework === 'claude-code'`. codex-cli / gemini-cli / pi-cli homes are never touched — `.claude.json` onboarding flags are a Claude Code concept by construction.

## Over-permit

The three flags are local trust acknowledgements (the operator manually accepted the same dialogs during incident recovery — this reproduces that state for pool homes). `bypassPermissionsModeAccepted` does not ENABLE bypass mode; it records that the mode's accept-screen was answered, which is precisely what an unattended relaunch cannot do itself. No trust scope widens beyond what every pre-incident pool home already required to function.

## Migration parity

Handled IN this change: existing agents get the sweep via `PostUpdateMigrator.migrate()` on update; new enrollments are seeded at completion; every launch re-ensures defensively (triple coverage). No CLAUDE.md/template surface changes — the feature is structural (Structure > Willpower), not agent-invoked.

## Token/cost impact

None. One stat + one small JSON read per pinned/swapped launch (write only when flags are missing — i.e., at most once per home). No LLM calls, no new polling.

## Test coverage

- Unit: `tests/unit/ensure-interactive-ready.test.ts` (14 — both sides of every boundary), `PostUpdateMigrator-subscriptionPoolInteractiveReady.test.ts` (8), `SessionRefresh.test.ts` (+4 ordering/fail-safe), `enrollment-wizard.test.ts` (+4 seam/wiring).
- Integration: `subscription-pin-sessions.test.ts` (+2 — both launch lanes land the flags on disk), `subscription-enrollment-interactive-ready.test.ts` (2 — full HTTP enroll→complete seeds flags, codex untouched).
- E2E: `subscription-enrollment-lifecycle.test.ts` (+1 feature-alive — real server, headless-state home becomes interactive-ready with credentials byte-identical).
