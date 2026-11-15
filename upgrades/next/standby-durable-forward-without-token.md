## What Changed
A machine that does not hold the Telegram login no longer loses a reply when the machine that sends for it is briefly unreachable. Before, it gave up without saving the reply and told the agent "may already be delivered, do not resend". Now it saves the reply and sends it, once, as soon as the sending machine answers again. A saved reply is never sent through a different bot than the one it was meant for. Other machines in the pool are told, with no message text, that a reply is pending, so a machine lost for good does not take its pending replies with it silently. The new saving is switched on for development agents first and reaches every agent through the usual rollout review.

## What to Tell Your User
If one of my machines can't reach the one that sends my Telegram messages, my reply is now kept and delivered when it's back, instead of being lost.

## Summary of New Capabilities
- Durable holding of replies on machines without the Telegram login (dev-gated: `telegramOrigin.tokenlessDurableForward.enabled`).
- `peerHeldDebt` in the Telegram origin status: replies pending on another machine past their deadline.
- An attention item when held replies were sealed for a bot the sending machine no longer uses.

## Rollback
To back out, first turn the gate dark: held replies keep draining. Revert fully only once the origin status shows no token-less held replies. Held replies still waiting at revert time would be lost, as they are today.

## Evidence
- `tests/unit/telegram-origin/tokenless-durable-forward.test.ts`, `tokenless-forward-evidence.test.ts`, `tokenless-held-debt.test.ts`, `tests/unit/telegram-reply-held-outcome.test.ts`, `tests/integration/telegram-origin-tokenless-forward.test.ts`.
- Lands after, or together with, native-conversation-base slice 3a, which removes the rule that let a newer message cancel a waiting reply.
- Unit: 3382 passed in the telegram, origin and migrator suites. Integration: 297 passed in the telegram and origin suites.
