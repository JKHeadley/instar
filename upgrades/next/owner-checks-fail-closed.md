<!-- bump: patch -->

## What Changed

Telegram approval buttons no longer accept anyone when no owner is known. Prompt-gate buttons and typed answers need the configured owner or the one verified operator. Tunnel consent needs the configured owner. Pairing taps refuse a tap with no chat id. A non-owner's typed reply is no longer taken as a prompt's answer, though the text can still reach the session as an ordinary message. An agent that has met someone but can't confirm a single owner records this at startup.

## What to Tell Your User

Approval buttons in Telegram now only work for you, even if your owner was never set up explicitly. If a button ever says I can't confirm who my owner is, tell me. Usually your message settles it. If I still can't confirm, I'll say so.

## Summary of New Capabilities

No new capabilities. This closes a gap where an unset owner meant anyone in the chat could answer.

## Evidence

`tests/unit/callback-owner-fails-closed.test.ts`, `tests/unit/threadline/PairingInviteTelegram.test.ts`, `tests/integration/callback-owner-wiring.test.ts`. The wiring test fails when the route wiring is removed. `tests/integration/pairing-invite-telegram-routes.test.ts`, `tests/integration/telegram-internal-routes-lifeline-secret.test.ts` and `tests/e2e/telegram-internal-routes-lifeline-secret-lifecycle.test.ts` still pass.
