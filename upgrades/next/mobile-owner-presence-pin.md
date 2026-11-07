## What Changed
The owner's paired iPhone can open Remote Desktop with Face ID instead of the dashboard PIN, and has a Dashboard PIN page.
- `POST /mobile/desktop-unlock` takes a fresh Face ID (presence-key) signature over a single-use, purpose-bound challenge, and returns a desktop-only session. That session is tied to the phone, lasts 15 minutes, is accepted only by the Remote Desktop routes, and ends when the phone is removed, the PIN changes or the switch is turned off.
- The phone's desktop calls are signed by the phone; it never receives the API token.
- `POST /mobile/dashboard-pin/reveal` returns the exact PIN this machine's dashboard checks. Where the owner has a private chat, it first tells them there, without the PIN. Every reveal is audited.
- The browser dashboard keeps its PIN unchanged.
- The switch is `mobilePairing.ownerPresence.enabled`: live on development agents, off on the fleet.

## What to Tell Your User
On your phone, Remote Desktop now opens with Face ID instead of your dashboard PIN. If a browser asks you for the PIN, the app has a Dashboard PIN page that shows it after Face ID. I'll message you privately whenever it's shown.

## Summary of New Capabilities
- Remote Desktop opens with Face ID on the owner's phone; no PIN to type.
- A Dashboard PIN page on the phone shows the PIN after Face ID, with a copy button that stays on the phone for one minute.

## Evidence
- `tests/unit/mobile-owner-presence.test.ts`:
  - the session store (expiry, two per phone, the one-second owner recheck, PIN-change clear);
  - message bytes and purpose separation;
  - the PIN value rule and the switch;
  - the CLAUDE.md migration;
  - a ratchet test pinning that phone sessions are only verified behind the `/desktop` caller binding.
- `tests/integration/mobile-owner-presence.test.ts`, through the real `authMiddleware` and `deviceAuthenticator`:
  - unlock, then a bound desktop call;
  - refusals for a bearer caller, another phone, an MSP phone, LAN, no presence key, a reused or cross-purpose challenge, a wrong-purpose signature, no PIN or a placeholder PIN, and the switch off;
  - the session ends on revoke, PIN change and switch off;
  - the reveal only after a confirmed notice, a failed notice, no chat, and a re-check after the wait.
- `tests/e2e/mobile-owner-presence-alive.test.ts`: alive on a development agent through the production `AgentServer`, dark on a fleet config.
- Existing suites updated:
  - the console-ticket switch test, since enrolment now also opens under this switch;
  - the owner-only allowlist set.
