# Held replies: "did it arrive?" instead of "send it again" — the plain version

## What the problem was

When I reply to someone on Telegram, my server does two things in a row. First it hands the message to Telegram. Then it writes down a receipt: "Telegram took it, here is its message number." Usually both work.

On 27 October the second step failed. Telegram had already taken the message and shown it to the person, but the little database that keeps receipts was busy restarting, so the receipt could not be written. The server then told me "this message is held, I don't know whether it got through." That was not true: it did know. Telegram had just answered with the message number. The server simply threw that answer away because it had nowhere to put it.

My reply tool printed that as a plain failure. So I did what anyone would do with "failed": I sent the message again. The person got it twice. The delivered copy was also missing from my message history, because history is written only after a clean success.

## What changes

1. **The server stops throwing the answer away.** If Telegram accepted a message and only the receipt write failed, the server now says so in a new, honest way: "delivered, but the receipt couldn't be saved", with Telegram's message number. It also writes that number into a small separate file on disk, which does not depend on the busy database. A few minutes later, when the database is back, the regular recovery pass copies the receipt into the database and marks the file entry done.

2. **Anyone can ask "did it arrive?"** There is a new question my sessions can ask the server, by the message's operation number. It answers one of five things: delivered, partly delivered, still waiting with the server (it will deliver it itself), not delivered (only then is sending again safe), or unknown. It never shows the message text. "Unknown" is used whenever a message went to Telegram and no answer came back: in that case it may well have arrived, so the answer is never "not delivered".

3. **The reply tool says it plainly.** When a reply is held, the tool now asks that question itself and prints one of: DELIVERED (don't resend), HELD (the server keeps it and will deliver it; don't resend), MAY ALREADY BE DELIVERED (don't resend; here is how to check), or NOT SENT (safe to send again).

4. **Delivered means delivered everywhere.** A message Telegram accepted now goes into my message history, and the duplicate guard remembers it, so if something does try to send the same text again, it is caught instead of going out twice. When the send happened through another of my machines, that machine answers "sent", so the first machine doesn't forward it again.

## What does not change

Normal successful sends behave exactly as before. A genuinely uncertain send (the network dropped after the request left) is still reported as uncertain and is never retried blindly. Nothing here gives any part of the system new power to block or send messages; it only reports more accurately what already happened.

## What a reader needs to decide

Nothing. This is a bug fix that makes an existing report honest and adds a read-only question. If it turned out wrong, undoing the code change is the whole rollback: the small receipts file is harmless if left behind.
