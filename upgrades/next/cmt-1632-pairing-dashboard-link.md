## What Changed
- **Pairing messages that send the owner to the dashboard now include a direct link.** When an agent cannot accept a pairing invite in Telegram (for example, no owner is set), refuses a button tap, sees an expired button, or sends a finish prompt while Telegram buttons are off, the message now links straight to the dashboard's Other agents page. The invite paste message also says what to tap: Connect another agent, then paste under "I was sent one". Before, these were fixed sentences with no link ("Open the Threadline tab on the dashboard"). When no address is known yet (the tunnel is still starting), the message names the page in plain words and invents no link. The invite itself is never put in a link, because it carries a one-time secret.

## What to Tell Your User
If I ever have to send you to the dashboard to finish pairing with another agent, my message now has a link that opens the right page. Tap it, then paste the invite where it says "I was sent one".

## Summary of New Capabilities
- Pairing refusals and prompts in Telegram link directly to the dashboard's Other agents page.

## Evidence
- `tests/unit/threadline/PairingInviteTelegram-dashboard-link.test.ts`: each of the four call sites carries the link when an address is known and plain words when not; a throwing address getter falls back to plain words; a known non-owner gets no link; a tap answer over Telegram's 200-character limit falls back instead of failing; the URL builder keeps only the origin and refuses non-http(s) or credentialed input; the adapter fallback line.
- `tests/integration/pairing-invite-telegram-routes.test.ts`: through the real routes wiring, the no-owner refusal links the public tunnel origin, uses localhost only with no tunnel, and names the page in plain words while a configured tunnel is still starting.
