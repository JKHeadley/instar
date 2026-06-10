<!-- bump: patch -->
<!-- change_type: fix -->

## What Changed

Fixes the 2026-06-09 incident where subscription-pool **pinning** and **account
swap** relaunched interactive sessions into pool-account config homes that were
enrolled via headless `claude auth login` — homes with valid OAuth tokens but
WITHOUT the interactive first-launch onboarding flags. Every relaunched session
wedged on Claude Code's onboarding screens (OAuth-authorize browser-tab spam +
the Bypass-Permissions accept screen); ~8 live sessions froze at once until the
operator logged in manually.

New util `ensureInteractiveReady(configHome)` idempotently seeds the three
local trust-acknowledgement flags (`hasCompletedOnboarding`,
`bypassPermissionsModeAccepted`, `hasTrustDialogAccepted`) in
`<configHome>/.claude.json`, preserving every other key and **never touching
`oauthAccount`/tokens** (an unparseable file is refused, not rewritten; writes
are atomic). It is fail-safe by contract — a launch can never crash on it.

Called everywhere a session can enter a pool home, so the wedge is impossible
by construction:

1. **Enrollment** — `EnrollmentWizard.complete()` seeds a freshly-enrolled
   claude-code home immediately.
2. **Pinned launches** — both SessionManager pin lanes (headless +
   interactive-reroute) and the interactive account-swap lane seed before
   setting `CLAUDE_CONFIG_DIR`.
3. **Swaps** — `SessionRefresh` seeds the target home BEFORE the kill+respawn.
4. **Existing homes** — a `PostUpdateMigrator` sweep seeds every claude-code
   pool account's existing home once on update (stale entries skipped, never
   created).

## What to Tell Your User

If I run on a pool of Claude accounts, moving my sessions between accounts
(when one hits its weekly limit) used to be able to freeze them on Claude's
"first launch" welcome screens — the account was logged in, but nobody had
ever clicked through the one-time setup dialogs for that account's config
folder. That's fixed at every layer now: new accounts are made
interactive-ready the moment they're enrolled, every launch double-checks, and
existing accounts get fixed automatically on this update. Account swaps should
now be invisible — same conversation, different account, no frozen sessions
and no browser-tab spam.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Pool config homes are onboarding-safe by construction (enrollment + every pinned/swapped launch) | automatic — no config |
| Existing pool homes seeded once on update | automatic — PostUpdateMigrator sweep |
| `ensureInteractiveReady(configHome)` util for any future launch lane | `src/core/ensureInteractiveReady.ts` |

## Evidence

Live state at the incident (this machine): `sagemind-justin` and `sagemind-dawn`
homes were fully headless (no flags), `justin-gmail` had onboarded=true but
bypass=false — exactly the homes whose sessions wedged; the two complete homes'
sessions were unaffected. The OAuth tokens were present in every case.

After the change:
- `tests/unit/ensure-interactive-ready.test.ts` — 14 cases: missing-file
  create, partial merge, flag-false reseed, idempotency (mtime-stable second
  call), oauthAccount/token preservation, tilde expansion, unparseable/
  non-object refusal with bytes preserved, unreadable fail-safe,
  requireExistingHome both sides.
- `tests/unit/PostUpdateMigrator-subscriptionPoolInteractiveReady.test.ts` — 8
  cases incl. one-bad-home-never-aborts-the-sweep and full-migrate() wiring.
- `tests/unit/SessionRefresh.test.ts` — flags land BEFORE the respawner fires
  (ordering pinned), fresh swaps too, no-swap untouched, fail-safe.
- `tests/integration/subscription-pin-sessions.test.ts` — both launch lanes
  land the flags on disk through the real SessionManager.
- `tests/integration/subscription-enrollment-interactive-ready.test.ts` +
  `tests/e2e/subscription-enrollment-lifecycle.test.ts` — full HTTP
  enroll→complete leaves the home interactive-ready, credentials
  byte-identical.
- `npm run lint` (tsc + all custom lints) clean; subscription/quota regression
  suites green.
