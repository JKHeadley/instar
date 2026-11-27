# "Next update by 7 PM" is now kept — ELI16

## What happened

On Friday 7 November at 5:01 PM, Echo sent Justin a status message that ended "Next update by about 7 PM." No update came. The session doing the work stopped a little after 6 PM, and nothing noticed that a message was owed. Justin found out 37 hours later by asking.

Instar already has a tool for exactly this: a "dated promise". If a promise is recorded with a time, the server posts a reminder in that conversation when the time arrives. It runs every five minutes, needs no session, and was switched on for Echo. It never fired because the promise was never recorded. Recording it depended on the session remembering to do so, and it forgot, for the third time in a month.

Two automatic promise-spotters exist, and both missed it. One only looks at "you asked, I agreed" exchanges, and this was an unprompted status update. The other only reads the first 500 characters of a reply, and the promise was at character 704. It also does not understand clock times like "7 PM".

## What changes

The server now reads every message the agent sends to a conversation, as it is sent. If a sentence promises the next message by a concrete time ("next update by about 7 PM", "I'll report back in 30 minutes", "you'll hear from me by noon tomorrow"), it records a dated promise for that time plus 15 minutes of slack. The session does not have to remember anything.

Any later message from the agent in that conversation counts as the update and closes the promise. A second message sent within five minutes of the first does not count, because long replies are often split into several messages.

If the time passes with no message, the existing reminder posts one plain line: "I said you'd have my next update by 7:00 PM, and I haven't sent it. I'm picking it back up now and will send it next." It quotes what was promised. Then it hands the promise back to that conversation's session, the same way a tap in the dashboard is handed over. A session that stopped is restarted. That session is told to send the update and resume the work.

## Safeguards

- It never blocks, changes or delays a message. It only writes a promise record, and any error inside it is logged and ignored.
- Only the agent's own messages count. User messages and automatic notices never create or close a promise.
- It is narrow on purpose. It needs both a "message is coming" phrase and a real time. "Later", "soon" and "end of day" are not captured. Neither are past-tense sentences like "I promised an update by 7 PM".
- Each promise fires at most once. Sending the reminder and handing it back are both recorded, so a re-run does nothing.
- The hand-back carries no sender identity, so the session cannot mistake it for an instruction from the operator.
- It follows the same on/off switch as the reminder: on for development agents like Echo, off for everyone else until the reminder is turned on. A separate switch, `commitments.promisedUpdateCapture.enabled`, turns just this part on or off.

## What the reader needs to decide

Nothing. This is a small change that a revert fully undoes. One open choice is worth knowing about: the reminder that this relies on is still off by default for agents other than development agents. Turning it on for everyone is a separate decision.
