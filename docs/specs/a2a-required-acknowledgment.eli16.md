# A sender is never left guessing (ELI16)

## What this is

When one agent messages another, the sender has often heard nothing for a long time, so the person asking gets told "they still haven't replied". Justin asked for a rule: an agent must at least say it got the message, summarize what was asked to prove it read it, and say it's working on a reply.

Here's what really happened on 4 November. Scout messaged Echo. The Mac Studio was already running its maximum of 20 sessions, so nothing could start to read the message. The server posted it in a chat topic, so Justin could see it and reasonably assumed Echo had too. Three quick retries failed, then retrying paused for 8 minutes. Scout got nothing back the whole time.

## What already exists

- An automatic note, "Message received. Composing response...", which is only sent once a working session really has the message.
- A label that marks a note like that as a receipt, so nobody replies to a receipt. This stopped an expensive loop of receipts answering receipts, and it must stay stopped.
- A record on the sender's side of what's still waiting for an answer.

## What changes

1. **The server answers straight away if no session can take the message.** It says: received, nobody has read it yet, and it could be lost. If it is lost, a second note says so, so the sender knows to resend. After a restart, the note says it may not have reached a session.
2. **The session that picks it up gives a one-line summary of what was asked.** It quotes a short code the server attaches to the message, which only arrives with the message. Sending a real reply straight away counts too.
3. **Forgetting gets noticed.** After 5 minutes without an acknowledgment, the session gets one reminder. After 15 minutes, the sender is told "a session has this and hasn't acknowledged it". No session or message is ever blocked.
4. **The sending agent can look up the truth.** Instead of "they still haven't replied", it can say "their server has it but no session has read it" or "they read it and are working on it".
5. **The 8-minute pause gets shorter.** When the only problem was a full session limit, retrying starts soon after a slot opens, with limits on how often.

## The safeguards

Earlier work deliberately chose not to send a "queued" note, for two good reasons. First, the waiting list is only in memory, so "queued" could overpromise. The new wording says the message could be lost, and a follow-up note reports it if it is, or says it can't tell after a restart. Second, older agents would treat an unfamiliar note as a real message and start a whole session for it. So these notes only go to agents whose own messages say they understand them. Everyone else gets what they get today.

New notes are receipts: they are never answered and never start or wake a session. That rules out the runaway back-and-forth that once cost real money. A note only counts if it refers to a message we really sent to that same agent, so a stranger can't fake "they read it". Summaries travel encrypted whenever the two agents can encrypt, because a summary restates the request. Messages an agent has decided need no reply don't need acknowledging either.

## What this doesn't do

It doesn't send waiting messages to another machine with room, and it doesn't label a message in a chat topic as "not read yet". Both are filed separately. It doesn't catch an agent that acknowledges and then goes quiet. It also can't prove a summary is good, only that a session which received the message wrote one. A reader can judge that for themselves.

## What you need to decide

Nothing, unless you disagree with the shape. It falls under the standing approval for agent communication work. It goes live for every agent on release, because both ends need it for it to work, and it has an off switch.
