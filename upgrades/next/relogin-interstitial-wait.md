# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The assisted re-login browser driver gave up on Claude's Cloudflare bot-check hold ("Just a moment…" / Turnstile). The page classified as `unknown`, whose only action is a 750 ms `wait`, and the drive loop allows 20 steps, so a drive spent at most 15 s on the hold and returned `provider-transient`. The hold clears by itself in roughly 30–90 s. Every attempt of the 2026-09-23 `justin-gmail` repair on the Studio died this way, and the episode failed with `attempt-budget-exhausted`.

- `ChromeCdpReloginBrowser.snapshot` now classifies the hold as a new closed page class, **`interstitial`**: title starting "Just a moment", the fixed hold wording ("verifying you are human", "checking your browser", "performing security verification", …), or a `challenges.cloudflare.com` iframe. It is checked before the prose chain so the hold text can never read as a form, and it is distinct from `captcha`, which stays operator-only.
- `AnthropicReloginBrowserDriver` waits an interstitial out on its **own bounded budget**: it polls every `INTERSTITIAL_POLL_MS` (3 s) up to `interstitialMaxMs` (default 90 s, capped at 5 min), those polls do not consume drive steps, and they never reach the Tier-1 supervisor (the only admissible action is `wait`). Past the budget the drive returns `provider-transient` exactly as before.

No config, route or on-disk format changes. `interstitialMaxMs` is a constructor option for tests and future tuning.

## What to Tell Your User

When the automatic sign-in repair opened Claude's sign-in page, it often met the "checking you're not a bot" screen. That screen clears on its own after half a minute or so, but the repair only waited about 15 seconds before giving up. It now recognizes that screen and waits patiently for up to a minute and a half, the same way a person would, and then carries on with the sign-in.

## Summary of New Capabilities

- Assisted re-login rides out the Cloudflare bot-check hold on Claude's sign-in page instead of failing in 15 seconds.

## Evidence

- Live, 2026-09-23 21:35–21:41Z on the Studio: episode for `justin-gmail` (v1.3.1269) reached `browser-driving` three times and returned `provider-transient` each time; the live Chrome tab showed title "Just a moment..." with a `challenges.cloudflare.com` Turnstile iframe. Earlier hand-driven sign-ins the same day cleared the identical hold after 30–90 s of polling.
- Tests: `tests/unit/anthropic-relogin-browser-driver.test.ts` (+3: 12 interstitial polls then authorize→paste-code completes, `wait(3000)` ×12, one supervisor call; budget exhaustion returns transient after exactly 3 polls with no supervision; `allowedActions` offers only `wait`). `tests/integration/chrome-cdp-relogin-browser.test.ts` (+1: a real headless Chrome classifies a "Just a moment..." page as `interstitial`). The unit tests fail against the pre-fix code. All 17 relogin test files are green, `tsc` clean.
