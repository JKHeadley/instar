# Organization "never" rules that check actions, in plain words

## What this is

Justin approved "easy setup for new people" on 16 November 2026. One part is that when someone's agent joins an organization, the organization's "never" rules should really hold, not just be advice. Today an agent reads the rules at the start of each conversation. Its outgoing messages are checked against them only if a setting is on, and that setting is off by default. Its actions, like emailing a spreadsheet or deleting a shared file, aren't checked at all. And where there is checking, it matches keywords, so "never share donor details" wouldn't catch "send the supporters spreadsheet to the venue".

## What already exists

- The organization's rules, which every joined agent holds, with a list of "never" items.
- A gate that sees the agent's tool calls to outside services and sorts them by whether they write, delete or send, and whether they can be undone.
- A keyword check that says whether an action matches a rule.
- A shared, rate-limited way to ask a small AI model a question, with a daily spending cap.

## What is new

- **A check before outward actions**, for agents that joined an organization only. Tool calls that write, send or delete, a short list of commands that send data off the computer or publish something, and outgoing messages.
- **Judged by meaning.** The keyword check is only a hint. Every check asks one short question of a small AI model on the agent's own account: "does this action break one of these never rules?" It reads what is actually being sent, not the agent's description of it.
- **Two modes.** In "observe" mode, which is all that ships now, nothing is blocked. The agent is told right away which rule might apply and who to ask, and the event is counted. In "block" mode, a likely breach is stopped, with the rule, who to ask, and an allowed alternative.
- **Block mode waits for Justin.** It can't be turned on until he says yes. He'll get one yes/no question with the exact wording.

## Safeguards

- Agents that haven't joined an organization are untouched.
- If the AI check can't run within 9 seconds, observe mode records that it couldn't check. Block mode holds the action until the person allows it once in the app. It never silently lets an action through.
- The check has its own small daily budget, and identical checks are remembered for ten minutes.
- Only the person, through the app, can turn block mode on, and only after Justin's yes.

## What it can't do yet

- Commands outside the listed ones aren't checked (scripts, `git push`, `npm publish`), nor what sits behind an ID the agent only names. These are stated as limits.
- The AI check can be wrong. Observe mode exists to measure how often before anything blocks.
- Rollout: observe mode ships with the normal release. Blocking is switched on one agent at a time, only after the operator's approval: first a test agent, then Echo, then everyone.

## What needs deciding

Justin's yes or no on turning on blocking for agents that join an organization. Nothing else.

Three small fixes after local verify: new agents now get the safety check at creation, not only after their first update; the check is listed with the other safety checks; and conversations are labelled by their plain id.
