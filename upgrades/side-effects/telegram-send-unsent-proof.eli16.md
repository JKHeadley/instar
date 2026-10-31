# Retrying replies that never left — in plain words

**The problem.** When Instar sends a Telegram reply and the network call fails, it has to decide whether the message might have arrived anyway. If it might have, Instar deliberately does not send it again, so you never get the same message twice. Until now it treated almost every failure after the send started as "might have arrived". The result: when the network had a brief hiccup at the exact moment of sending, the reply was simply lost. On 31 October four replies in the dashboard conversation disappeared this way within ten minutes, and the Studio had about 200 such cases in a week.

**What changes.** Some failures prove the message never left: the computer could not find Telegram's address, or could not open a connection at all. No connection means nothing was sent. Those failures are now marked "failed, safe to retry", and the normal retry sends the reply a moment later. Failures after a connection was open are still treated as "might have arrived", exactly as before, so this can't cause duplicates in those cases.

**What else.** Every send that ends as "might have arrived" now writes the exact network error to the log, so the next step on the remaining losses is based on evidence rather than guesses.

**Safeguards.** Only clear "never connected" errors qualify, and retries stay inside each message's existing limit and deadline. Bot tokens are removed from the log line.

**What to decide.** Nothing beyond review. Reverting the change restores the old behaviour.
