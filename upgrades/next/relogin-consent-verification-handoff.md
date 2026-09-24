# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Assisted re-login: a consent/authorize click that does not go through is now handed to the operator instead of retried. Live, 2026-09-24 on the Studio: the agent pressed **Authorize** on Claude's consent page (right account, allowed scopes) and the button stayed busy forever — the click sent only `edge-api/client-health/check` and never the authorize request, while `js.hcaptcha.com` was loaded; in a second automated browser the same sign-in showed an hCaptcha image challenge. So after a consent click (either driver) the drive allows `CONSENT_STUCK_MS` (15 s) for the page to leave the authorize step; if it has not, the drive ends `operator-only / captcha` (the parent's rule: never retry through a provider risk control), which parks the episode and sends the existing operator notice. A **visible** hCaptcha frame (> 50×50 px) now classifies as `captcha`; a hidden one does not.

## What to Tell Your User

Claude now sometimes asks automated sign-ins to solve a picture puzzle before it will authorize. The automatic repair can't and won't solve those, so when it hits one it now stops right away and asks you to finish that one step (open the sign-in link, tap Authorize), instead of trying three times and failing quietly.

## Summary of New Capabilities

- Sign-in repair recognizes a provider human-verification check at the Authorize step and hands it to the operator immediately.

## Evidence

- Live probes (Studio, 2026-09-24 19:22–19:28 UTC) as described above: button `aria-busy="true"` and disabled after the click, no authorize request, `window.hcaptcha` present; the Playwright browser showed "Click on every object that makes light" (hCaptcha) on "Continue with Google".
- Tests: `tests/unit/agent-relogin-navigation.test.ts` (+1: a consent click whose page stays on authorize past the window ends `operator-only / captcha` after exactly one click); `tests/integration/chrome-cdp-relogin-browser.test.ts` (+1, real Chrome: visible hCaptcha frame → `captcha`, hidden → not).
