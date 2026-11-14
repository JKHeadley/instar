# App conversations move between machines — the short version

Your agent can run on several of your machines at once. A Telegram conversation can already be moved from one machine to another: you tap Move, pick the machine, confirm with Face ID, and the conversation carries on over there. Justin asked for the same with app conversations.

Today all app conversations live together on whichever machine is currently in charge. This part lets you move one to another machine. The rules are deliberately strict, because the worst outcome is two machines answering the same conversation:

- **A conversation moves only when you move it, and only after its session on the old machine has fully stopped.** If stopping fails, nothing moves, and you're told to try again. Nothing else in the system may move an app conversation by itself.
- **A moved conversation comes home on its own if its machine goes dark.** It returns to the machine in charge, the one it lived on before.
- **A machine that just took charge waits until it's caught up** before answering conversations it thinks were never moved. That way it can't answer one that was actually moved a moment ago.
- **Every one of your machines needs the update.** If an older machine joins, moved conversations come home first.

Your messages from the phone reach the right machine wherever the phone is connected. Replies show up everywhere. A support person's conversation only moves to a machine that keeps private memory. A conversation's memory notes stay on the machine that wrote them, and the move tells you that.

Slack conversations don't move. They stay with the machine that holds your Slack connection (part 3a).

What you need to decide: nothing.
