# Sign-in Repair Uses the Saved Authenticator at Google's Phone Prompt

## What Changed

The automatic sign-in repair's helper session no longer stops at Google's "Check your phone" prompt when the account signs in with a password plus an authenticator whose secret is saved. On a Google page headed "2-Step Verification", it now chooses "Try another way", picks the Google Authenticator option and enters the code, with at most two codes. Google's risk checks ("Verify it's you", unusual activity, a CAPTCHA) are still never worked around. A page the helper cannot place is treated as a risk check. The helper reads the page heading from the page itself before acting, and Instar checks it. The first three uses on each machine are supervised by the server: a new use waits until the previous one is reviewed (`POST /subscription-relogin/EPISODE/authenticator-review`). Each attempt records what happened (code accepted, rejected, or no authenticator option) and whether the heading matched, in the repair's audit trail. Development agents start in a shadow mode, where the helper only reads and records the heading, and the step is turned on per machine once that evidence checks out (`subscriptionPool.assistedRelogin.authenticatorOverPhone`: `true`, `'shadow'` or `false`; off on the fleet). The /subscription-signin skill gains one line saying that in a repair the helper's prompt takes precedence.

## What to Tell Your User

Nothing changes for you yet: this is switched on only for development agents while it is being proven.

## Summary of New Capabilities

On development agents, unattended sign-in repair can finish Google's two-step sign-in with the saved authenticator code instead of waiting for a phone tap.

## Evidence

Mama PC (account B, 2026-11-26) and the Laptop (account A, 2026-11-25) both stopped at the phone prompt with an authenticator saved. Unit tests cover the prompt rules, the audit notice and the skill migration, in tests/unit/relogin-authenticator-over-phone-prompt.test.ts.
