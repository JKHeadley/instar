# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The assisted re-login browser step can now be navigated by a model instead of the fixed page-class table (spec `docs/specs/agent-driven-relogin.md`, approved 2026-09-24). With `subscriptionPool.assistedRelogin.navigation: 'agent'`, on every page that is not a terminal or safety page (hold, CAPTCHA, phone confirmation, passkey terminal pages, success, paste code — all unchanged), `AnthropicReloginBrowserDriver` observes the page's visible controls (`ChromeCdpReloginBrowser.observeControls`, never an input value), builds a floor-filtered offer (`buildAgentOffer`) and asks the shared intelligence provider for exactly one token: a numbered control (`click:<n>`, clicked by `clickControl` only while its text is unchanged), a typed fill offered by input presence, `wait`, or `give-up`.

The floors, deterministic and unit-tested on both sides: sign-in origins only (existing check); no control naming another account; no control containing a destructive or credential-creating phrase (sign out, delete, manage, use another account, create a passkey, set up, …); consent-capable controls only when the page's scopes were read, are non-empty and within `allowedScopes`; labels redacted (every secret resolved in the drive stripped verbatim, foreign emails and long tokens masked, disclosed truncation at 60 characters); the existing seat lease; and a hard drive deadline (default 8 minutes) raced against every browser and model call. Success is still decided only by `verifyIdentity` + `verifyAuthenticatedUse`.

Selection: `navigation` omitted ⇒ `agent` on a development agent, `closed` on the fleet (`resolveReloginNavigation`). An agent-navigated drive records `agent-drive-started` instead of `browser-drive-started` in the episode events. Passkey enrollment drives always keep the closed table. The CLAUDE.md template and `migrateClaudeMd` gain an "Agent-navigated sign-in (dev-gated)" bullet.

## What to Tell Your User

Nothing changes for your agent unless it is a development agent. On a development agent, the automatic sign-in repair now reads each sign-in page and chooses the next step itself, instead of following a fixed list of page types — so an unexpected page no longer stops the repair. The locks stay the same: it only ever works on the real sign-in sites and the right account, never sees a password or code, never approves extra permissions, and Instar still checks the signed-in account itself.

## Summary of New Capabilities

- Agent-navigated sign-in repair (development agents): an unexpected sign-in page no longer ends the repair.

## Evidence

- Tests: `tests/unit/agent-relogin-navigation.test.ts` (12: every floor both sides, redaction, drive loop through an unknown page, invalid token ends the drive, CAPTCHA never reaches the model, hard deadline against a stalled call, enrollment stays closed, navigation resolution); `tests/integration/chrome-cdp-relogin-browser.test.ts` (+1, real headless Chrome: visible controls listed without input values, hidden/disabled excluded, identities read, click refused when text changed); `tests/integration/subscription-relogin-runtime.test.ts` (+1: runtime drives an unknown page via the agent, `agent-drive-started` recorded, "Sign out" never offered, verification decides success); `tests/e2e/subscription-relogin-lifecycle.test.ts` (+1: through the production AgentServer approval surface, the events route names the agent driver); `PostUpdateMigrator-assistedRelogin` (awareness bullet added once, idempotent). `tsc` clean.
