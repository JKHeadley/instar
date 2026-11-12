# Keeping a reply safe when the sending Mac is unreachable (plain-English overview)

## What happens today

Echo runs on several machines at once. Today the pool lists five, all online: the Mac Studio, the Mac Mini, the Mac M5 Pro, a laptop, and one listed as "Mama PC". Any of them can write a reply, but only one sends Telegram messages at a time: whichever machine holds the sending role. Right now that's the Studio. A machine that has the Telegram login could take over the role. One that doesn't, like the M5, hands its replies to whichever machine holds the role.

A machine that holds the login hands replies over carefully. If the sending machine doesn't answer, it saves the reply, retries on a schedule, and sends it when the sending machine is back. A machine without the login, like the M5, uses an older shortcut. It asks the sending machine "are you there?", and if it doesn't answer at that moment, it gives up without saving the reply. Worse, it tells the agent "this may have been delivered, don't resend". The reply is simply gone.

That happened twice on November 11, both times from the M5, while the Studio was briefly down. The second lost message was the explanation of the first loss. It had to be resent by hand.

## What changes

1. **Machines without the login use the careful way too.** They only needed the login for one public number, the bot's account number, and they get it from the sending machine's own "I'm here" answer each time.
2. **If the sending machine can't be reached, the reply is saved anyway.** It gets a "number to be filled in" placeholder. When a sending machine answers again (the same one, or another that has taken over the role), the saved reply is sealed with the real number and sent, once.
3. **If the sending machine is suddenly using a different bot** from the one a reply was sealed for, the reply is not sent automatically. You get a dashboard item naming both bots, so a misconfigured machine can never post your conversation through the wrong bot.
4. **If the sending role briefly moves to a machine without the login,** which can't send, the reply waits instead of getting stuck.
5. **No more false "don't resend".** If a reply really wasn't saved, the agent is told "not sent, safe to send again".
6. **Several replies saved during one outage never cancel each other out.** A saved reply is only set aside if a newer, live reply from the agent reached you first. A message from you, or another saved reply, never sets it aside.
7. **"Your reply is delayed" notices aren't saved for later.** So you never get a stale delay notice after the reply itself. They're re-posted once a sending machine is reachable again, if still relevant.
8. **The other machines are told.** While a reply is saved only on the machine that wrote it, that machine tells every other machine it can still reach, with no message text, just "a reply is pending here". If that machine were lost for good, the others would show it as lost instead of it vanishing.

## Safeguards

- Machines without the login never get it.
- The sending machine still checks every reply against its own login.
- A wrongly sealed reply is refused before anything is sent, so there are no double messages.
- Machines that already have the login behave exactly as before.

It's switched on for my development setup first, and goes to every agent only after the usual rollout review sees it working: at least one real recovered reply, and no losses.

It's tested with a pretend sending machine that goes offline and comes back, plus the lost-answer, role-flapping and two-replies cases. Then it's tested on the real machines: the Studio is briefly cut off, and a reply from the M5 has to arrive afterwards with no manual resend.

## What you need to decide

1. Whether to approve the plan.
2. Approving it also approves one exception to the multi-machine rule: during an outage, a not-yet-sent reply is kept only on the machine that wrote it, while the other machines are told it exists. The alternative, copying unsent reply text to every machine, would spread your conversation content further.
