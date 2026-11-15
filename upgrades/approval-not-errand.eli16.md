# Asking for a yes instead of handing over the chore

## What happened

On Nov 14 an agent sent Justin a status report that said, in effect, "pay the $25 Google Play fee from the link in the Android conversation, then reply paid". The agent already had that fee page open in its own browser, signed in to Justin's account, with his saved card. So the only part that was really Justin's was saying yes to spending $25. The message got two things wrong: it gave him work the agent could do, and it did not even include the link, it pointed at another conversation. The mistake started with a note from earlier that night that said "Justin pays", which the agent copied forward without checking.

## Why the existing checks missed it

Instar's message reviewer (the smart gate that reads every message before it goes out) already holds messages that hand the user work the agent could do. But it has an exception for payments, because spending money is the user's call. That exception was written as "payment is human-only", so the reviewer let "you pay it" through. Nothing told it that deciding to pay and doing the paying are two different things.

## What this change does

1. The message reviewer gets a new rule, judged by meaning, on every normal and job-written message. Every step for the user is one of two kinds. A decision, like spending money, accepting terms or choosing an option, is the user's to decide and the agent's to carry out. A truly physical or personal step, like a photo of an ID, a fingerprint or face check, a code on their own phone, or a CAPTCHA, is the user's to do. Payments are decisions. If a message tells the user to do a decision-kind step that the agent could do once approved, or asks for an approval but points at a link somewhere else instead of including it, the reviewer holds it and suggests: ask one yes-or-no question with the cost and the direct link, and say "I'll do it on your yes".
2. The reviewer now also sees which accounts the agent's browser is signed in to, so it can tell "the agent has the account and the saved card" from "only the user can do this".
3. Every agent's CLAUDE.md gets a short "Your Turn to Do It" trap entry saying the same thing, including: check an old "user pays" note before repeating it.

There is no word list. Justin asked that this be judged by meaning, so the rule is given to the reviewer on every message rather than only when certain words appear.

## What already existed

The message reviewer, its "false blocker" rule (B17), its exceptions for payments, and the list of the agent's signed-in browser accounts all existed. This change adds one more paragraph to that rule and passes the account list in more often. No new service, setting or route.

## Safeguards

When the reviewer is unsure whether the agent could do the step, it lets the message through. A held message comes back to the agent with the reason, and the agent can rewrite it or send it anyway with a reason, so a wrong hold costs one rewrite. Health alerts are not affected. This change does not let any agent spend money on its own: the yes still has to come from the user.

## What you need to decide

Nothing. This is a wording and checking change that a revert fully undoes.
