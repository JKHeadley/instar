# Keeping a reply safe when the sending Mac is unreachable (plain-English overview)

## What happens today

Justin's agent runs on two Macs. Only the Mac Studio actually sends Telegram messages, because it holds the Telegram login. The other Mac, the M5, writes replies and hands them to the Studio to send.

A Mac that holds the login hands replies over carefully. If the Studio doesn't answer, it saves the reply, retries on a schedule, and sends it when the Studio is back. A Mac without the login, like the M5, uses an older shortcut. It asks the Studio "are you there?", and if the Studio doesn't answer at that moment, it gives up without saving the reply. Worse, it tells the agent "this may have been delivered, don't resend". The reply is simply gone.

That happened twice on November 11, both times while the Studio was briefly down. The second lost message was the explanation of the first loss. It had to be resent by hand.

## What changes

1. **The M5 uses the careful way too.** It only needed the login for one public number, the bot's account number, and it gets that from the Studio's own "I'm here" answer each time.
2. **If the Studio can't be reached, the reply is saved anyway.** It gets a "number to be filled in" placeholder. When the Studio answers again, the saved reply is sealed with the real number and sent, once.
3. **If the Studio is suddenly using a different bot** from the one a reply was sealed for, the reply is not sent automatically. You get a dashboard item naming both bots, so a misconfigured machine can never post your conversation through the wrong bot.
4. **If the "who sends" role briefly moves to the M5,** which can't send, the reply waits instead of getting stuck.
5. **No more false "don't resend".** If a reply really wasn't saved, the agent is told "not sent, safe to send again".
6. **Several replies saved during one outage never cancel each other out.** A saved reply is only set aside if a newer, live reply from the agent reached you first. A message from you, or another saved reply, never sets it aside.
7. **"Your reply is delayed" notices aren't saved for later.** So you never get a stale delay notice after the reply itself. They're re-posted once the Studio is back, if still relevant.
8. **The other machines are told.** While a reply is saved on the M5 only, the M5 tells every other machine it can still reach, with no message text, just "a reply is pending here". If the M5 were lost for good, the others would show it as lost instead of it vanishing.

## Safeguards

- The M5 never gets the secret login.
- The Studio still checks every reply against its own login.
- A wrongly sealed reply is refused before anything is sent, so there are no double messages.
- Machines that already have the login behave exactly as before.

It's switched on for my development setup first, and goes to every agent only after the usual rollout review sees it working: at least one real recovered reply, and no losses.

It's tested with a pretend Studio that goes offline and comes back, plus the lost-answer, role-flapping and two-replies cases. Then it's tested on the real Macs: the Studio is briefly cut off, and a reply from the M5 has to arrive afterwards with no manual resend.

## What you need to decide

1. Whether to approve the plan.
2. Approving it also approves one exception to the multi-machine rule: during an outage, a not-yet-sent reply is kept on the M5 only, while the other machines are told it exists. The alternative, copying unsent reply text to every machine, would spread your conversation content further.
