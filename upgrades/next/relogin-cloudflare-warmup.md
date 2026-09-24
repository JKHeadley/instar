# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Assisted re-login: when Cloudflare's "Just a moment…" hold does not clear within the hold budget, the driver now closes the automated browser, runs the same profile's Chrome **plainly** — no debugging port or pipe — on the sign-in link for 45 s (`ChromeCdpReloginBrowser.warmUpPlain`), quits it, reopens the automated browser and continues. At most once per drive, inside the existing drive deadline and seat lease. Live evidence, Studio 2026-09-24: the `justin-google` profile sat on the hold for 12+ minutes across three automated drives and two attached probes (even with CDP `Runtime` events off), while fresh profiles passed at once; one plain launch cleared it and every automated visit afterwards went straight through (the clearance cookie stays in the profile). Both drivers get it; the agent-drive step trail records `plain-warm-up`.

## What to Tell Your User

Sometimes Claude's sign-in page gets stuck on a "checking your browser" screen for a particular saved browser, and the automatic repair gave up. It now opens that browser normally for a moment so the check can pass, then carries on with the repair.

## Summary of New Capabilities

- Automatic sign-in repair recovers from a Cloudflare check that never clears under automation.

## Evidence

- Live probes described above (Studio, 2026-09-24 17:25–17:39 UTC).
- Tests: `tests/unit/agent-relogin-navigation.test.ts` (+3: one warm-up then success; at most once; old behaviour without the capability); `tests/integration/chrome-cdp-relogin-browser.test.ts` (+1, real Chrome: refuses while the automated browser is open, refuses non-https, runs ≥ the requested time, never opens a debugging port).
