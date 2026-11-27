# Every reminder carries the ask — the plain-English version

> The one-line version: whenever an agent says it is still waiting on you for something, the message has to link to where it asked (or the card that holds it) and say again, in one plain line, what it needs and what reply settles it.

## The problem in one breath

An agent ended a message with "Still waiting on you: the screen-lock question I sent at 2:46." To answer, Justin would have had to scroll back, find that message, and work out what reply the agent wanted. Instar already has a rule that a new ask must carry its links, but nothing covers the later reminders, and that is exactly where this went wrong. Worse, an agent could not have added a link even if it wanted to: nothing in Instar knows how to build a link to a Telegram or Slack message.

## What already exists

- **"Every ask carries its links"**: a written rule (from earlier this month) that a message asking the person for a review, approval or decision ends with a short "What I need from you" section, with links and the exact reply. It is only an instruction; nothing checks it.
- **The outbound message reviewer**: every message an agent sends to its person is read by a model first. Some of its rules are "nudges": the message is handed back to the agent with a suggestion, and the agent either fixes it or sends it unchanged with a written reason. One of those nudges already catches "go look at the dashboard" without a link.
- **Work Board cards**: a card can hold a decision the agent needs, and the dashboard can open a card directly.

## What this adds

The biggest piece is a new nudge in the outbound reviewer. When a message refers to something the agent is still waiting on the person for, asked earlier, and it does not link to where it was asked and restate the ask with the exact reply that settles it, the message is handed back to the agent before it sends. The reviewer decides by meaning, not by looking for particular words, so "the screen-lock thing is still open on your side" counts just like "still waiting on you". It does not fire on a message that makes a new ask in full, on one that waits on something other than the person (like a build finishing), or on a report that the person already answered.

The other pieces:

- **Links an agent can build.** A new small tool turns "topic 141385, message 145385" into a real Telegram link that opens that message on the phone. It also makes Slack message links, a link to an app conversation, and a link to a Work Board card. Agents can ask the server for a link to any message they know the number of. To find an old message they use the search tools that already exist.
- **The link at send time.** When an agent sends a Telegram or Slack message, it now gets that message's link back right in the send output, so it can keep it for later reminders. If an agent asks for a link to a message number this computer has no record of, the answer says the number could not be confirmed, so a misremembered number does not turn into a confident wrong link.
- **The written standard.** The rule is added to Instar's constitution, next to "Every ask carries its links", quoting Justin's approval ("standard yes", message 145385).
- **Every agent learns it.** A short note goes into every agent's instructions on its next update.

## The safeguards

- It is a nudge, never a wall. No message is dropped or held for good: the agent can always send with a reason, and that reason is recorded so the rule can be tuned.
- When unsure, the reviewer lets the message through. It fires only when a message plainly points back at an open ask with neither a link nor a restatement.
- A link is only built when it will really open. Chats that have no shareable message links get an honest "can't link this" instead of a broken link, and the agent then restates the ask in full and says so.
- It starts on Echo only. Other agents get the nudge once it has proved itself on Echo for two weeks: enough real nudges, mostly accepted by the agent as right, and no bare reminder slipping through to Justin.
- Only messages written by a live agent session are checked. Reminders built by fixed code (scheduled notices) cannot respond to a nudge, so checking them would lose the reminder; bringing those under the rule is tracked as its own follow-up item.
- There is an off switch. Turning it off makes the reviewer behave exactly as it does today.

## What you need to decide

Justin already said yes to the standard. Because it changes the constitution, the pull request also needs his code-owner approval on GitHub before it can merge; the Chief of Staff will bring him the link.

## If it turns out wrong

Turn the switch off, or revert the change. The link tool and the extra field on the send answer are additions that nothing else depends on, and no stored data changes.
