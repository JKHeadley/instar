# The trust journey, in plain words

## What this is

Today an Instar agent has one trust level per service, and nothing the person can see shows how the agent has been doing. This spec lets trust grow the way it does with a new colleague: you start where you are comfortable, you can see the agent's track record, and when the record is good the agent offers to stop asking. You decide every widening yourself.

## What changes for the person

- **One question at the start.** "How careful should I be to start?" Careful, Balanced or Trusting fills in a setting for each kind of change (write, modify, delete, per service). If you skip it, nothing is granted and the agent asks before acting.
- **Three settings per kind of change (reading is not gated), in everyday words.** "Ask me first", "Do it and show me" (it acts and keeps each action in a record you can open, with undo where possible), and "Just do it". "Don't do this" blocks a kind.
- **When the agent asks.** It stops, sends you the exact action in your chat, and waits. Your reply lets that one action through once; a different or repeated action asks again.
- **Some things always ask.** Spending above your limit, anything irreversible outside the agent's role, speaking publicly in your name, widening the agent's own authority, and anything you marked sensitive. No setting or offer can lower these.
- **A visible record.** Every ask shows a line like "Last 30 days: asked 12, approved unchanged 11, changed 1. Checked fine 9, corrected 1, not yet checked 2." It is counts, never a score, and gaps are stated.
- **Offers, never takings.** When the record supports it, the agent offers "Stop asking for these?" covering exactly what you have been approving. You approve by replying "approve" and a short code to the offer in your private chat. Declining is one reply and is not repeated without new evidence. An unanswered offer changes nothing.
- **Mistakes narrow one kind only,** and only if you chose that condition when you granted it. Otherwise the agent explains and proposes the narrowing.
- **Teams.** The owner's settings are the ceiling. A member can make the agent more careful with their own things, never less.

## The security fix first

Today the agent's own access key can raise its trust, or switch off the safety gate, without you. Stage 0 closes that for every agent. A raise needs your approval, given by replying "approve" and a short code to the request in your private Telegram chat or Slack DM with the agent. You first send one message agreeing to use that chat for approvals. Every such approval is marked "approved from your account, which your agent can also use; this does not prove who approved", because the agent can reach that account too. The dashboard PIN and phone taps are not enough on their own, because the agent can reach them. Your current settings keep working exactly as they do today, marked as set before approval was required.

## Tradeoffs

An agent that can edit the files on its own computer could still forge an approval. No software on that same computer can stop that; it needs an outside verifier, which is separate work. That is also why Face ID approval waits: today the agent's own server pairs the phone. With more than one machine, the one currently serving decides every raise and every action that depends on a grant, so machines never act on an out-of-date setting; if it is unreachable, those actions wait. The record only counts outcomes someone actually checked, so it starts small. Nothing in the constitution changes; suggested wording that would make the journey explicit, including allowing Face ID approval sooner, is a separate decision for Justin.
