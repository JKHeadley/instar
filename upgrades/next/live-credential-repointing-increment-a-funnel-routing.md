# Upgrade Guide — Live credential re-pointing (Increment A, Step 4b)

<!-- bump: patch -->

## What Changed

Step 4b of the live-credential-repointing build (Subscription & Auth Standard), shipping **dark**. Every in-process write to the `Claude Code-credentials` keychain store now routes through the Step-4a `CredentialWriteFunnel`'s per-slot lock, so two writers to the same config home serialize instead of interleaving:

- `OAuthRefresher.refreshClaudeToken` wraps its token write in `withSlotLock(credentialSlotKey(configHome), …)`. A lock-acquire timeout returns a new typed reason `write-skipped` — the OAuth exchange already succeeded and the existing valid credential is left untouched.
- `QuotaPoller.pollAccount` maps `write-skipped` to "no snapshot this cycle, retry next tick" — explicitly NOT `needs-reauth`. A momentarily-busy lock can no longer cry-wolf a healthy login into a re-auth prompt.
- `CredentialProvider` adds `writeCredentialsSerialized`, the one sanctioned chokepoint that serializes a provider write; `AccountSwitcher` now uses it (a busy lock returns a non-destructive "store busy, try again").
- A new lint, `lint-no-unfunneled-credential-write.js` (wired into `npm run lint`), forbids any future unfunneled write to the Claude credential store — the structural guarantee that no new code path can bypass the lock. It is file-scoped to the guarded service, so the other keychain vaults are never false-flagged.
- `credentialSlotKey` canonicalizes the lock key so a refresh and a switch on the same home always share one lock regardless of path spelling.

The credential-repointing feature gate is untouched and remains off + dry-run. With no swap running (always, while dark), the funnel adds only per-slot ordering and a bounded skip-retry under contention — behaviorally identical to before.

## What to Tell Your User

Nothing changes for you right now — this is internal plumbing for the upcoming restartless subscription rebalancing, and it is shipping switched off. When that feature is eventually turned on, it will be able to move an account's login between config slots without ever interrupting a session; this step lays the safety groundwork so two background credential operations can never step on each other and accidentally knock a healthy login into a "please log in again" state. You don't need to do anything, and you won't see any difference until the feature is explicitly enabled.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Serialized credential writes (per-slot lock) | Automatic (internal) — every Claude credential write is now ordered through one funnel |
| Busy-lock safety on token refresh | Automatic — a contended refresh retries next cycle instead of triggering needs-reauth |
| Unfunneled-write lint guard | Automatic at build time (`npm run lint`) |

## Evidence

- 15 new unit tests (`credential-write-routing.test.ts`, `lint-no-unfunneled-credential-write.test.ts`) plus all 193 pre-existing credential/oauth/quota/account-switcher tests green (208 total). The routing tests prove end-to-end that a busy lock yields `write-skipped` → no-snapshot and does NOT mark `needs-reauth`, with a CONTRAST test proving a genuine `exchange-failed` still does.
- `npx tsc --noEmit` clean; full `npm run lint` chain clean (including the new lint and the destructive-tool lint with the new script allowlisted).
- Independent second-pass reviewer subagent: **CONCUR** — traced the token-refresh hot path, confirmed no regression, no lock-wedge, no double-lock, and a sound lint on both axes; the one non-blocking concern (lock-key string fragility) was fixed inline via `credentialSlotKey`.
