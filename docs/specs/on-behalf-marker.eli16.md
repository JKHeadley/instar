# Messages an agent sends as its operator are always marked

## What this change is

An agent sometimes needs to send a message through its operator's own account. The usual case is a test: the agent is signed in to the operator's Slack in its browser, and it posts a message to itself so it can see the conversation appear. On 2026-11-09 the operator, Justin, asked for a rule for this. Every message the agent sends as him must be clearly marked, and the existing Telegram signing work should be generalized to cover it.

## What already exists

- On Telegram, messages an agent sends through the operator's account already carry a cryptographic signature. When one comes back in, the agent's session is told it was written by the agent, not the person.
- Slack had nothing like this. A message the agent posted from the operator's Slack account came back looking exactly like the operator typed it. The agent could then take its own test message as an instruction from the operator.

## What is new

1. **One fixed marker for every platform:** `[Sent by <agent> on <operator>'s behalf]`, with `, test` inside the brackets for a test. A small shared module writes it and reads it.
2. **Slack recognises it.** When a Slack message that starts or ends with the marker reaches the agent, its tag says "marked: sent by Echo on Justin's behalf, not written by Justin". The thread history the agent reads shows the same label. So the agent never takes its own test message as the operator's words.
3. **Every agent learns the rule.** A short section in each agent's instructions covers it, and existing agents get it on update. It says: check your own reach first (your key reads the dashboard data; your browser profiles list signed-in accounts), look or check things yourself, mark everything you send as the operator, and never make a purchase, change a setting or send a real message to someone else in the operator's name without asking.

## The safeguards

- The marker can only lower trust. If someone types it, they just mark their own message as not theirs. It never grants anything and never claims to be verified, so it needs no signature.
- It counts only at the very start or end of a message. A marker quoted mid-message, for example someone explaining the format, is ignored.
- Names in the marker are stripped to plain characters, so a marker can't break the tag it is placed in.

## What the reader needs to decide

Nothing. It is on by default. To undo it, revert the change. It stores no state.
