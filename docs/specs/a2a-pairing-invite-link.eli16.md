# Pairing two agents by invite link, explained simply

Before two agents trust each other with secrets like passwords, each needs proof that it is talking to the real other agent, not an impostor in the middle. The relay that carries their messages could, in theory, swap one agent's key for its own. Pairing is how they rule that out.

The first version asked the person to read 12 words on one screen, compare them with 12 words on another, and then type all 12 in. Justin tried it and stopped: it is too much for anyone to do every time, and the screen kept wiping his progress. He was right, and this replaces it.

## What the person does now

1. On your agent's dashboard (or by asking your agent in Telegram), you make an invite. It is one short message with a code in it.
2. You send it privately to the other person, in whatever app you already use with them.
3. They forward it to their own agent's Telegram chat (or paste it into their dashboard). Their agent asks: "Pair with the agent that calls itself Scout, which says it belongs to Justin?" They tap Approve.
4. Your agent tells you who accepted, and you tap Finish.

Nobody reads, compares or types anything.

## Why it is safe

- The invite travels through your own chat app, not through our relay, so whoever runs the relay never sees it.
- The invite contains a one-time secret. The other agent proves it got the invite (with that secret) and proves it holds its own key (with a signature). An impostor would need both.
- Each agent also checks the key in the invite against the key the relay shows. If they differ, it refuses.
- An invite works once and expires after an hour by default, so keep it private until it is used.
- If someone else got hold of your invite and used it first, the real person's later attempt sets off an alarm on your side. The agent that got in first is paused straight away, even if you already tapped Finish, and it can't receive any secrets until you choose which one you meant.
- Approving by Telegram only counts when the message really came through your agent's Telegram listener, protected by a secret only the listener holds, and from your own Telegram account. Otherwise you approve on the dashboard with your PIN.

## What it can't do

It can't stop you from approving an agent you don't know. That's why the screen always says the names are "claimed", not checked.
